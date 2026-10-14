import { SourceInfo } from '../types'

export interface ImprintAreaEstimate {
  /** Front face: W x H in inches */
  frontIn: { w: number; h: number }
  /** Back face: W x H in inches */
  backIn: { w: number; h: number }
  /** Wrap / continuous: W x H in inches */
  wrapIn: { w: number; h: number }
  /** Confidence 0-1 based on how much data we had */
  confidence: number
  /** 估算依据（中文） */
  rationale: string
}

const CM_TO_IN = 0.3937
const SAFE_MARGIN = 0.85 // 留 15% 边距（客户实际能印区域通常比产品外形小）

/** 从 sizeCn / carton / weight 三个数据源尽力推断产品的 L×W×H（cm） */
function inferProductDimsCm(source: SourceInfo): { l: number; w: number; h: number; basis: string } {
  const sz = (source.sizeCn ?? '').toString()

  // 1) 解析 sizeCn：支持 "20x7cm" / "20*7*15cm" / "20 cm" / "Φ20cm" 等格式
  const cmMatches = [...sz.matchAll(/(\d+(?:\.\d+)?)\s*(cm|厘米|mm|毫米)?/gi)]
  const nums = cmMatches
    .map((m) => {
      let n = Number(m[1])
      if (Number.isFinite(n)) {
        const unit = (m[2] ?? '').toLowerCase()
        if (unit === 'mm' || unit === '毫米') n = n / 10
        return n
      }
      return 0
    })
    .filter((n) => n > 0 && n < 200)
  if (nums.length >= 2) {
    // 排序后取前 3 个作为 L×W×H
    const sorted = nums.slice(0, 3).sort((a, b) => b - a)
    return { l: sorted[0], w: sorted[1] ?? sorted[0] * 0.6, h: sorted[2] ?? sorted[0] * 0.3, basis: 'sizeCn' }
  }

  // 2) 兜底：用 carton 推算
  if (source.cartonLCm && source.pcsPerCarton && source.pcsPerCarton > 0) {
    // 假设箱子是按层堆叠的；每个产品 ≈ carton / 2
    const perL = source.cartonLCm * 0.5
    const perW = (source.cartonWCm ?? source.cartonLCm * 0.8) * 0.5
    const perH = (source.cartonHCm ?? source.cartonLCm * 0.6) * 0.5
    return { l: perL, w: perW, h: perH, basis: 'carton' }
  }

  // 3) 重量兜底（很粗）：假设 1g ≈ 1cm³ 密度（保温杯/塑料制品粗估）
  if (source.weightG && source.weightG > 0) {
    // 体积 ≈ 重量g（粗略），开立方得边长，再按 2:1.5:1 比例分配
    const side = Math.cbrt(source.weightG)
    return { l: side * 1.6, w: side * 1.2, h: side, basis: 'weight' }
  }

  // 4) 终极兜底
  return { l: 15, w: 10, h: 5, basis: 'default' }
}

/** 材质系数：平面 1.0，曲面 0.7（杯/瓶的可见印面要打折） */
function materialFactor(text: string): { factor: number; hint: string } {
  const t = text.toLowerCase()
  if (/玻璃杯|陶瓷|杯|瓶|壶|jar|mug|bottle|cup|tumbler|glass/.test(t))
    return { factor: 0.65, hint: '曲面' }
  if (/球|圆|环|手柄|球形|globe|sphere/.test(t)) return { factor: 0.5, hint: '强曲面' }
  if (/布|帆布|棉|布袋|布包|涤|fabric|canvas|cotton|polyester|文创|袋子|包/.test(t))
    return { factor: 0.95, hint: '平面' }
  if (/纸|卡|page|notebook|book|册|笔记本|便签/.test(t)) return { factor: 0.95, hint: '平面' }
  return { factor: 0.85, hint: '半曲面' }
}

/** 估算产品的可印面（英寸） */
export function estimateImprintArea(source: SourceInfo): ImprintAreaEstimate {
  const dims = inferProductDimsCm(source)
  const matFactor = materialFactor(
    [source.materialCn, source.description, source.notes, source.sourceTitle].filter(Boolean).join(' ')
  )
  // 兜底：L 取最大，W 次之，H 最小
  const L = Math.max(dims.l, dims.w, dims.h)
  const W = [dims.l, dims.w, dims.h].sort((a, b) => b - a)[1] || L * 0.6
  const H = [dims.l, dims.w, dims.h].sort((a, b) => b - a)[2] || L * 0.4

  // 安全印面 = 边长 × 0.85（留 15% 边距） × 材质曲面系数
  const front = {
    w: round1(L * CM_TO_IN * SAFE_MARGIN * matFactor.factor),
    h: round1(W * CM_TO_IN * SAFE_MARGIN * matFactor.factor),
  }
  const back = { w: front.w, h: front.h } // 一般前面/背面同尺寸
  // Wrap = 沿最长边环绕，宽度 = 周长 × 系数，高度 = 较短边 × 系数
  const wrapW = round1(L * 2 * CM_TO_IN * matFactor.factor * 0.7)
  const wrapH = round1(H * CM_TO_IN * SAFE_MARGIN * matFactor.factor)
  // Wrap 高度受限于曲面（杯身通常只露 60%），再减一点
  const wrap = { w: wrapW, h: Math.min(wrapH, round1(wrapW * 0.4)) }

  const confidence =
    dims.basis === 'sizeCn' ? 0.9 : dims.basis === 'carton' ? 0.7 : dims.basis === 'weight' ? 0.4 : 0.2

  const rationale =
    `依据产品${dims.basis === 'sizeCn' ? '尺寸' : dims.basis === 'carton' ? '箱规' : dims.basis === 'weight' ? '重量' : '默认'}估算` +
    `（${matFactor.hint}，留 15% 边距），请按真实产品外形微调。`

  return { frontIn: front, backIn: back, wrapIn: wrap, confidence, rationale }
}

function round1(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0
  return Math.round(v * 10) / 10
}

/** 转成 ASI 平台可填的 imprintArea 字符串（inch） */
export function estimateToImprintString(est: ImprintAreaEstimate): string {
  const f = est.frontIn
  const b = est.backIn
  const w = est.wrapIn
  return (
    `Front: ${f.w}" W x ${f.h}" H` +
    (Math.abs(b.w - f.w) > 0.01 || Math.abs(b.h - f.h) > 0.01
      ? `; Back: ${b.w}" W x ${b.h}" H`
      : '') +
    `; Wrap: ${w.w}" W x ${w.h}" H`
  )
}

/** 解析 AI 返回或用户输入的 imprintArea 字符串 → 三面尺寸（无法解析时给空） */
export function parseImprintArea(text: string): Partial<ImprintAreaEstimate> | null {
  if (!text || !text.trim()) return null
  const out: Partial<ImprintAreaEstimate> = {}
  const get = (label: string) => {
    const re = new RegExp(`${label}\\s*:?\\s*([\\d.]+)\\s*"?\\s*W?\\s*[xX×*]\\s*([\\d.]+)\\s*"?\\s*H`, 'i')
    const m = text.match(re)
    if (!m) return null
    const w = Number(m[1])
    const h = Number(m[2])
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null
    return { w: round1(w), h: round1(h) }
  }
  const f = get('Front')
  const b = get('Back')
  const w = get('Wrap')
  if (f) out.frontIn = { w: f.w, h: f.h }
  if (b) out.backIn = { w: b.w, h: b.h }
  if (w) out.wrapIn = { w: w.w, h: w.h }
  if (!f && !b && !w) return null
  return out
}
