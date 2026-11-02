/**
 * 评分 v2：可复现的「按市场 list 价反算赚不赚钱」
 *
 * 背景：原来的 evaluation.score 是 AI 给的综合印象分，没有把「按 ESP 目录价（list）= 报价 ÷ 0.6
 * 能不能赚钱」算进去，导致大量产品落在 MAYBE。v2 把这件事变成可计算的：
 *
 *   净价（你报出去的价） = 市场 list × 0.6
 *   真实全成本          = 引擎落地成本 × (1 + 损耗 + 支付 + 账期)
 *   毛利                = (净价 - 真实全成本) / 净价
 *   采购价上限          = 当前采购价 - (真实全成本 - 净价 × 目标毛利)
 *
 * 分数 = 毛利分(40) + 价格空间分(30) + 物流分(10) + 品类分(20)
 * 判定与分数分开：判定看毛利/上限，分数只负责排序。
 */

export interface ScoreGridRow {
  qty: number
  unitCostCny: number
  allInCostUsd?: number
  unitPrice: number
}

export interface ScoreInput {
  priceCny: number | null
  priceAdviceUsd?: { min: number; max: number } | null
  similarPriceRangeUsd?: { min: number; max: number } | null
  priceGrid: ScoreGridRow[]
  asiCategories?: string[]
}

export interface ScoreV2 {
  score: number | null
  verdict: 'GO' | 'NEGOTIATE' | 'NO' | 'UNKNOWN'
  /** 250 件档毛利率（0-1） */
  margin: number | null
  /** 采购价上限（¥/件）；低于它 → 30% 毛利 */
  ceilingCny: number | null
  /** 市场参考 list 价（USD） */
  listUsd: number | null
  /** 判定用的档位数量 */
  qty: number | null
  parts: { margin: number | null; headroom: number | null; logistics: number | null; category: number }
  listSource: 'priceAdvice' | 'similar' | 'none'
}

const TRANSACTION_FEE_RATE = 0.085 // 损耗 3% + 支付 2.5% + 账期 3%
const TARGET_MARGIN = 0.30
const TARGET_QTY = 250

const HOT = ['drinkware', 'bag', 'apparel', 'headwear', 'tech', 'notebook', 'pen', 'writing', 'outdoor', 'towel', 'blanket', 'fitness', 'travel']
const MID = ['home', 'houseware', 'kitchen', 'office', 'stationery', 'sport', 'pet', 'beauty', 'gift']

function hotScore(categories: string[]): number {
  const c = categories.join(' ').toLowerCase()
  if (HOT.some((k) => c.includes(k))) return 20
  if (MID.some((k) => c.includes(k))) return 12
  return 5
}

function pickTier(grid: ScoreGridRow[]): ScoreGridRow | null {
  if (!grid.length) return null
  return grid.find((g) => g.qty === TARGET_QTY) ?? grid.find((g) => g.qty >= TARGET_QTY) ?? grid[grid.length - 1]
}

export function computeScoreV2(input: ScoreInput, fxRate: number): ScoreV2 {
  const empty: ScoreV2 = {
    score: null,
    verdict: 'UNKNOWN',
    margin: null,
    ceilingCny: null,
    listUsd: null,
    qty: null,
    parts: { margin: null, headroom: null, logistics: null, category: hotScore(input.asiCategories ?? []) },
    listSource: 'none',
  }

  const tier = pickTier(input.priceGrid)
  if (!tier || !Number.isFinite(tier.allInCostUsd ?? NaN)) return empty

  let list: number | null = null
  let listSource: 'priceAdvice' | 'similar' | 'none' = 'none'
  const adv = input.priceAdviceUsd
  if (adv && Number.isFinite(adv.min) && Number.isFinite(adv.max) && adv.max > 0) {
    list = (adv.min + adv.max) / 2
    listSource = 'priceAdvice'
  } else {
    const sim = input.similarPriceRangeUsd
    if (sim && Number.isFinite(sim.min) && Number.isFinite(sim.max) && sim.max > 0) {
      list = (sim.min + sim.max) / 2
      listSource = 'similar'
    }
  }
  if (list == null) return empty

  const landedUsd = tier.allInCostUsd as number
  const trueCostCny = landedUsd * fxRate * (1 + TRANSACTION_FEE_RATE)
  const netCny = 0.6 * list * fxRate
  if (!(netCny > 0)) return empty

  const margin = (netCny - trueCostCny) / netCny
  const priceCny = input.priceCny

  let ceilingCny: number | null = null
  if (priceCny != null) ceilingCny = priceCny - (trueCostCny - netCny * (1 - TARGET_MARGIN))

  const freightShare =
    priceCny != null && tier.unitCostCny > 0
      ? Math.max(0, (tier.unitCostCny - priceCny) / tier.unitCostCny)
      : null

  const marginPart = (Math.min(Math.max(margin, 0), 0.45) / 0.45) * 40
  const headroomPart =
    ceilingCny != null && priceCny != null && priceCny > 0
      ? Math.min(Math.max(ceilingCny / priceCny, 0), 1) * 30
      : null
  const logisticsPart =
    freightShare == null ? null : freightShare <= 0.15 ? 10 : freightShare >= 0.5 ? 0 : ((0.5 - freightShare) / 0.35) * 10

  const categoryPart = hotScore(input.asiCategories ?? [])
  const score =
    headroomPart != null && logisticsPart != null
      ? Math.max(0, Math.min(100, Math.round(marginPart + headroomPart + logisticsPart + categoryPart)))
      : null

  const verdict: ScoreV2['verdict'] =
    margin >= TARGET_MARGIN ? 'GO' : margin > 0 && ceilingCny != null && ceilingCny > 0 ? 'NEGOTIATE' : 'NO'

  return {
    score,
    verdict,
    margin: Math.round(margin * 10000) / 10000,
    ceilingCny: ceilingCny == null ? null : Math.round(ceilingCny * 100) / 100,
    listUsd: Math.round(list * 100) / 100,
    qty: tier.qty,
    parts: {
      margin: Math.round(marginPart * 10) / 10,
      headroom: headroomPart == null ? null : Math.round(headroomPart * 10) / 10,
      logistics: logisticsPart == null ? null : Math.round(logisticsPart * 10) / 10,
      category: categoryPart,
    },
    listSource,
  }
}
