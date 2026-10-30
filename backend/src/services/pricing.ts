import { PriceRow, Settings, SourceInfo } from '../types'

export interface CostBreakdown {
  qty: number
  shipping: 'air' | 'sea'
  /** 体积重（kg），来自箱规 */
  volumetricKg: number
  /** 实际毛重（kg），来自箱规毛重或单件×每箱 */
  actualKg: number
  /** 计费重 = max(体积重, 实际毛重) */
  billableKg: number
  /** 商品成本（¥/件） */
  goodsCny: number
  /** 运费（¥/件）= 计费重 × 费率 ÷ 每箱数量（单独列示） */
  freightCny: number
  /** 印刷成本（¥/件） */
  printCny: number
  /** 样品费摊销（¥/件，仅首档承担） */
  sampleCny: number
  /** 杂费（¥/件）= 售价折 CNY × miscFeePct% */
  miscCny: number
  /** 全口径成本（¥/件）= 商品+运费+印刷+样品+杂费 */
  allInCostCny: number
  unitCostCny: number
  unitPrice: number
  margin: number
  markupRate: number
  /** 阶梯卖点：用户提示「海运第一档 < 空运最后一档」 */
  note?: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** ASI 阶梯档位总数：8 档（前 4 档空运、后 4 档海运） */
export const TIER_COUNT = 8
/** 默认档位（首档无法计算时的兜底） */
export const DEFAULT_QTY_LEVELS = [50, 100, 250, 500, 1000, 2500, 5000, 10000]
/** 前几档走空运（默认 4） */
export const DEFAULT_AIR_QTY_LEVELS = 4

/** 整数档位候选（30/50/100/…，业务习惯值） */
const NICE_QTYS = [
  30, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000,
  4000, 5000, 7500, 10000, 15000, 20000, 25000, 50000,
]

function niceQtyAtLeast(v: number): number {
  for (const n of NICE_QTYS) if (n >= v) return n
  return Math.ceil(v / 5000) * 5000
}

/**
 * 需求 7：报价阶梯数量自动定档。
 * - 第一档：数量 × 首档售价 ≥ $200，从 30/50/100 等整数中取最小满足值（下限 30）
 * - 后面几档：按 ×2 / ×2.5 的节奏递增，同样吸附到整数档（如 100/200/500/1000/2500）
 * - 首档售价越高，起始数量越小（比如 $10 的产品 30 件就够 $300）
 */
export function suggestQtyLevels(firstTierPriceUsd: number): number[] {
  if (!Number.isFinite(firstTierPriceUsd) || firstTierPriceUsd <= 0) {
    return [...DEFAULT_QTY_LEVELS]
  }
  const minQty = 200 / firstTierPriceUsd + 1 // 严格大于 $200
  const first = niceQtyAtLeast(Math.max(minQty, 30))
  // 8 档：首档 + 7 次递增（前 4 档空运、后 4 档海运）
  const MULTS = [2, 2.5, 2, 2, 2.5, 2, 2]
  const levels = [first]
  let cur = first
  for (let i = 0; i < MULTS.length; i++) {
    cur = Math.max(niceQtyAtLeast(cur * MULTS[i]), cur + 30)
    levels.push(cur)
  }
  return levels
}

function applyRounding(price: number, mode: Settings['rounding']): number {
  if (mode === 'cent05') return Math.ceil(price / 0.05) * 0.05
  if (mode === 'end99') return Math.floor(price) + 0.99
  return round2(price)
}

/**
 * ASI 标准定价：
 * 1) 体积重 (kg) = L * W * H / volumetricDivisor（默认 5000）
 * 2) 实际毛重 (kg) = cartonGwKg ?? 单件重量 * pcsPerCarton
 * 3) 计费重 = max(体积重, 实际毛重)
 * 4) 单件到岸成本 (元) = 计费重 * 费率 / 每箱数量 + 产品单价 (元)
 *    - 前 airQtyLevels 档走空运，费率 airRateCnyPerKg（默认 50 元/kg）
 *    - 其余档走海运，费率 seaRateCnyPerKg（默认 20 元/kg）
 * 5) ASI 售价 (USD) = 单件到岸成本 (元) * 倍率 / 汇率
 *    - 空运档：第 1 档 = markupAir（默认 1.4），最后一档自动抬升以保证 ≥ 海运第一档售价
 *    - 海运档：从 1.4 线性插值到 1.25（markupSea）
 *    - 中间档可选随机抖动 ±10%
 *
 * 约束：「海运第一档售价 < 空运最后一档售价」——若基础倍率不满足，自动上调空运最后一档的
 * 倍率使满足；同时价格是单调递减的（50→2500）。
 */
export function buildPriceGrid(
  source: Pick<
    SourceInfo,
    'priceCny' | 'weightG' | 'cartonLCm' | 'cartonWCm' | 'cartonHCm' | 'pcsPerCarton' | 'cartonGwKg'
  >,
  settings: Settings
): { rows: PriceRow[]; breakdowns: CostBreakdown[] } {
  const fx = Number(settings.fxRate) || 6.7
  const airRate = Number(settings.airRateCnyPerKg) || 50
  const seaRate = Number(settings.seaRateCnyPerKg) || 20
  const divisor = Number(settings.volumetricDivisor) || 5000
  const markupAir = Number(settings.markupAir) || 1.4
  const markupSea = Number(settings.markupSea) || 1.25
  const strategy = settings.midStrategy ?? 'linear'

  const unitPriceCny = Number(source.priceCny) || 0
  const singleKg = (Number(source.weightG) || 0) / 1000
  const pcs = Math.max(1, Number(source.pcsPerCarton) || 1)

  const volumetricKg = ((Number(source.cartonLCm) || 0) *
    (Number(source.cartonWCm) || 0) *
    (Number(source.cartonHCm) || 0)) / divisor
  const boxGw = Number(source.cartonGwKg) || 0
  const actualKg = boxGw > 0 ? boxGw : singleKg * pcs
  const rawBillableKg = Math.max(volumetricKg, actualKg)
  // 运费计费重按 0.5kg 为单位四舍五入（如 11.8 → 12，11.3 → 11.5），与货代计费规则一致
  const billableKg = rawBillableKg > 0 ? Math.round(rawBillableKg * 2) / 2 : 0

  // 每档成本：到岸成本 = 商品 + 运费（运费单独列示，不并入杂费）
  const airUnitCost = billableKg > 0 ? (billableKg * airRate) / pcs + unitPriceCny : unitPriceCny
  const seaUnitCost = billableKg > 0 ? (billableKg * seaRate) / pcs + unitPriceCny : unitPriceCny
  const airFreightCny = billableKg > 0 ? (billableKg * airRate) / pcs : 0
  const seaFreightCny = billableKg > 0 ? (billableKg * seaRate) / pcs : 0

  // 毛利润口径（用户确认）：①商品成本 ②运费（单独） ③印刷 ¥1.5/件 ④样品费 ¥300 摊首档 ⑤杂费 = 售价 × 5%
  const printCny = Number(settings.printCostCny) || 0
  const sampleFee = Number(settings.sampleFeeCny) || 0
  const miscPct = Number(settings.miscFeePct) || 0

  // 需求 7：默认按「首档 数量×售价 ≥ $200」自动定档；manual 模式才用手填档位
  const firstTierPriceUsd = (airUnitCost * markupAir) / fx
  const levels =
    settings.qtyLevelsMode === 'manual' && settings.qtyLevels?.length
      ? [...settings.qtyLevels].sort((a, b) => a - b)
      : suggestQtyLevels(firstTierPriceUsd)
  const airQty = Math.max(1, Math.min(levels.length - 1, settings.airQtyLevels ?? 3))

  // 海运第一档倍率固定 1.4
  const seaStartMarkup = 1.4
  const seaStartPrice = (seaUnitCost * seaStartMarkup) / fx

  // 空运最后一档最小倍率（保证海运第一档 < 空运最后一档）
  // airLastPrice = airUnitCost * airLastMarkup / fx > seaStartPrice
  // airLastMarkup > seaStartPrice * fx / airUnitCost
  const minAirLastMarkup = airUnitCost > 0 ? (seaStartPrice * fx) / airUnitCost : markupAir
  // 空运最后一档基础倍率 1.32（默认 8% 阶梯度），不满足约束时抬升
  const baseAirLastMarkup = 1.32
  const airLastMarkup = Math.max(baseAirLastMarkup, minAirLastMarkup + 0.01)

  // 构造 6 档倍率数组
  const markups: number[] = []
  for (let i = 0; i < airQty; i++) {
    const t = airQty > 1 ? i / (airQty - 1) : 0
    markups.push(markupAir + (airLastMarkup - markupAir) * t)
  }
  const seaCount = levels.length - airQty
  for (let i = 0; i < seaCount; i++) {
    const t = seaCount > 1 ? i / (seaCount - 1) : 0
    markups.push(seaStartMarkup + (markupSea - seaStartMarkup) * t)
  }

  const breakdowns: CostBreakdown[] = []
  const rows: PriceRow[] = levels.map((qty, idx) => {
    const shipping: 'air' | 'sea' = idx < airQty ? 'air' : 'sea'
    const unitCostCny = shipping === 'air' ? airUnitCost : seaUnitCost
    let markup = markups[idx]
    if (strategy === 'random' && idx > 0 && idx < levels.length - 1) {
      markup = markup * (1 + (Math.random() - 0.5) * 0.2)
    }

    const rawUsd = (unitCostCny * markup) / fx
    const unitPrice = round2(applyRounding(rawUsd, settings.rounding))

    // 全口径成本：商品 + 运费 + 印刷 + 样品摊销（仅首档） + 杂费（售价 × %）
    const freightCny = shipping === 'air' ? airFreightCny : seaFreightCny
    const sampleCny = idx === 0 && qty > 0 ? sampleFee / qty : 0
    const fixedCostCny = unitPriceCny + freightCny + printCny + sampleCny
    const miscCny = (miscPct / 100) * unitPrice * fx
    const allInCostCny = fixedCostCny + miscCny
    const grossProfit = unitPrice - allInCostCny / fx
    // 毛利润按实时汇率换算成人民币（fxRate 由 fx 服务定时拉取并写回设置库）
    const grossProfitCny = grossProfit * fx
    const margin = unitPrice > 0 ? grossProfit / unitPrice : 0

    let note: string | undefined
    if (idx === airQty && seaCount > 0) {
      note = '海运第一档'
    } else if (idx === levels.length - 1) {
      note = '海运末档'
    }

    const bd: CostBreakdown = {
      qty,
      shipping,
      volumetricKg: round2(volumetricKg),
      actualKg: round2(actualKg),
      billableKg: round2(billableKg),
      goodsCny: round2(unitPriceCny),
      freightCny: round2(freightCny),
      printCny: round2(printCny),
      sampleCny: round2(sampleCny),
      miscCny: round2(miscCny),
      allInCostCny: round2(allInCostCny),
      unitCostCny: round2(unitCostCny),
      unitPrice,
      margin: Math.round(margin * 1000) / 10,
      markupRate: Math.round(markup * 100) / 100,
      note,
    }
    breakdowns.push(bd)

    return {
      qty,
      billableKg: bd.billableKg,
      unitCostCny: bd.unitCostCny,
      unitCost: round2(unitCostCny / fx),
      fixedCostUsd: round2(fixedCostCny / fx),
      miscUsd: round2(miscCny / fx),
      allInCostUsd: round2(allInCostCny / fx),
      grossProfit: round2(grossProfit),
      grossProfitCny: round2(grossProfitCny),
      totalGrossProfitUsd: round2(grossProfit * qty),
      totalGrossProfitCny: round2(grossProfitCny * qty),
      unitPrice,
      margin: bd.margin,
      shipping,
      markupRate: bd.markupRate,
      code: `${levels.length}C`,
    }
  })

  return { rows, breakdowns }
}

/** 给 AI 看的成本摘要，避免模型瞎编 */
export function costSummaryForPrompt(
  source: Pick<
    SourceInfo,
    'priceCny' | 'weightG' | 'cartonLCm' | 'cartonWCm' | 'cartonHCm' | 'pcsPerCarton' | 'cartonGwKg'
  >,
  settings: Settings
): string {
  const { rows, breakdowns } = buildPriceGrid(source, settings)
  const lines = [
    `1688 unit price: ¥${source.priceCny ?? '?'}`,
    `Carton: ${source.cartonLCm ?? '?'}x${source.cartonWCm ?? '?'}x${source.cartonHCm ?? '?'} cm, ${source.pcsPerCarton ?? '?'} pcs/ctn, ${source.cartonGwKg ?? '?'} kg`,
    `Billable weight: ${breakdowns[0]?.billableKg ?? '?'} kg (volumetric ${breakdowns[0]?.volumetricKg ?? '?'} vs actual ${breakdowns[0]?.actualKg ?? '?'})`,
    `FX: 1 USD = ${settings.fxRate} CNY; air ¥${settings.airRateCnyPerKg}/kg, sea ¥${settings.seaRateCnyPerKg}/kg`,
    `Volumetric divisor: ${settings.volumetricDivisor}; markup air=${settings.markupAir}, sea=${settings.markupSea}; airQtyLevels=${settings.airQtyLevels ?? 3}`,
    `Extra per-unit costs: print ¥${settings.printCostCny ?? 1.5}; sample fee ¥${settings.sampleFeeCny ?? 300} charged to the first tier only; misc = ${settings.miscFeePct ?? 5}% of the selling price (handling 3% + wastage 1% + FX buffer 1%)`,
    `Calculated price grid (authoritative, USD):`,
    ...breakdowns.map(
      (b, i) =>
        `  ${b.qty} pcs [${b.shipping.toUpperCase()} mark=${b.markupRate}] goods+freight=¥${b.unitCostCny.toFixed(2)} all-in=¥${b.allInCostCny.toFixed(2)} -> $${rows[i].unitPrice.toFixed(2)} (gross profit $${rows[i].grossProfit.toFixed(2)} = ¥${(rows[i].grossProfitCny ?? 0).toFixed(2)}, total gross profit for ${b.qty} pcs: $${(rows[i].totalGrossProfitUsd ?? 0).toFixed(2)} = ¥${(rows[i].totalGrossProfitCny ?? 0).toFixed(2)}, margin ${b.margin.toFixed(0)}%)`
    ),
  ]
  return lines.join('\n')
}

/** 把 SourceInfo 中的尺寸 / 重量换算成 ASI 平台用的英制字段 */
export function convertUnits(source: SourceInfo): {
  unitWeightLb: number | null
  cartonGwLb: number | null
  cartonSizeInch: string
  productSizeInch: string
  productSizeCm: { l: number; w: number; h: number } | null
} {
  const unitWeightLb =
    source.weightG && source.weightG > 0 ? Math.round((source.weightG / 453.592) * 100) / 100 : null
  const cartonGwLb =
    source.cartonGwKg && source.cartonGwKg > 0
      ? Math.round(source.cartonGwKg * 2.20462 * 100) / 100
      : null
  const cartonSizeInch = [source.cartonLCm, source.cartonWCm, source.cartonHCm].every(
    (n) => typeof n === 'number' && n > 0
  )
    ? `${(Number(source.cartonLCm) / 2.54).toFixed(2)}" L x ${(Number(source.cartonWCm) / 2.54).toFixed(2)}" W x ${(Number(source.cartonHCm) / 2.54).toFixed(2)}" H`
    : ''
  const productSizeInch = convertProductSizeCn(source.sizeCn, source.weightG)
  const productSizeCm = parseProductSizeCm(source.sizeCn, source.weightG)
  return { unitWeightLb, cartonGwLb, cartonSizeInch, productSizeInch, productSizeCm }
}

function convertProductSizeCn(sizeCn: string, _weightG: number | null): string {
  const text = sizeCn?.trim() ?? ''
  const m = text.match(/(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*cm/i)
  if (m) {
    const w = Number(m[1]) / 2.54
    const h = Number(m[2]) / 2.54
    return `${w.toFixed(2)}" W x ${h.toFixed(2)}" H`
  }
  if (/oz/i.test(text)) return ''
  const dia = text.match(/[ØD直径]\s*(\d+(?:\.\d+)?)\s*cm/i)
  if (dia) return `${(Number(dia[1]) / 2.54).toFixed(2)}" Diameter`
  return ''
}

/** 从 1688 尺寸文案（如 "8x12cm" / "直径 7cm"）解析出产品本身的厘米尺寸 {l,w,h}（用于提交表最右列填入） */
export function parseProductSizeCm(
  sizeCn: string | undefined | null,
  weightG: number | null | undefined
): { l: number; w: number; h: number } | null {
  const text = (sizeCn ?? '').trim()
  if (text) {
    // 常见：7.5x20cm / 8*12cm / 7.5 x 20 CM
    const grid = text.match(/(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*cm/i)
    if (grid) {
      const a = Number(grid[1])
      const b = Number(grid[2])
      return { l: Number(a.toFixed(1)), w: Number(b.toFixed(1)), h: Number(b.toFixed(1)) }
    }
    // 单边长：7cm / 直径7cm / 7.5cm
    const single = text.match(/[ØD直径]?\s*(\d+(?:\.\d+)?)\s*cm/i)
    if (single) {
      const a = Number(single[1])
      return { l: Number(a.toFixed(1)), w: Number(a.toFixed(1)), h: Number(a.toFixed(1)) }
    }
  }
  // 仅靠重量兜底：按密度估算一个近似立方体积再开三次方
  if (weightG && weightG > 0) {
    const cm3 = weightG / 0.8 // 取常见促销品平均密度 0.8 g/cm³
    const side = Math.cbrt(cm3)
    const s = Math.round(side * 10) / 10
    if (s > 0) return { l: s, w: s, h: s }
  }
  return null
}