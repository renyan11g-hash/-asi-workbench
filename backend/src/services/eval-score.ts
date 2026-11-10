/**
 * 总分合成（AI 只判五个维度，总分由系统算）
 *
 * 为什么要系统算，而不是让 AI 直接给一个分：
 *   1. 可复现 —— 同样的五维分，任何人算出来都是同一个总分，能复盘、能对账。
 *   2. 防漂移 —— AI 的自评分经常围着 60-75 打转，不敢给低分；拆成五个维度后，
 *      每一维都有明确的判断依据，逼它把「差在哪」写出来。
 *   3. 可解释 —— 用户看到的不是一个孤零零的数字，而是「哪一维拖了后腿」。
 *
 * 权重依据（按促销礼品这门生意真实的卡点排序）：
 *   差异化 28%  —— ASI 目录里同款泛滥是常态，客户买的是"为什么选你"。没有差异化只能拼价格。
 *   定制可行 22% —— ASI 生意的本质是印 logo。不能印、印不好、要开模，就不是促销礼品。
 *   物流体积 18% —— 促销品单价低（常见 $2-15），运费占比是生死线；泡货/重货直接吞掉毛利。
 *   市场竞争 17% —— 同款供应商数量决定价格战烈度，也决定你的客户会不会拿别家来压价。
 *   合规风险 15% —— 平时是加分项，一旦踩到 IP/认证就是闸门（见下面的封顶规则）。
 *
 * 闸门规则（关键）：某些维度不是"扣几分"，而是"直接封住上限"。
 *   合规 < 40  → 总分封顶 40（侵权/认证风险的损失远大于这点利润，直接放弃）
 *   差异化 < 30 → 总分封顶 55（同款烂大街，只能拼价格，做不出溢价）
 *   定制 < 30  → 总分封顶 60（做不出定制 = 无法作为促销礼品销售）
 *   物流 < 25  → 总分封顶 70（泡货/重货在低价带必亏）
 *   分销商都不卖 → 总分封顶 55（需求未验证：可能是伪需求，先别投钱开模备货）
 */

export interface ScoreBreakdown {
  differentiation: number
  customization: number
  shipping: number
  competition: number
  compliance: number
}

/** 外部证据触发的闸门（五维分表达不了，但必须拦住总分的结论） */
export interface ScoreGates {
  /** 分销商目录里没有任何一家在卖同类：需求未验证 */
  demandMissing?: boolean
}

export const SCORE_WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  differentiation: 0.28,
  customization: 0.22,
  shipping: 0.18,
  competition: 0.17,
  compliance: 0.15,
}

export const DIM_LABEL: Record<keyof ScoreBreakdown, string> = {
  differentiation: '差异化',
  customization: '定制可行',
  shipping: '物流体积',
  competition: '市场竞争',
  compliance: '合规风险',
}

export interface ComposedScore {
  score: number
  verdict: 'GO' | 'MAYBE' | 'NO'
  /** 一句话说明分数是怎么来的（触发闸门时会点明） */
  note: string
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))

/** 把 AI 返回的五个维度解析成规范化的 0-100 整数；缺项/非法 → null（老数据保持原分） */
export function parseBreakdown(raw: unknown): ScoreBreakdown | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const keys = Object.keys(SCORE_WEIGHTS) as Array<keyof ScoreBreakdown>
  const out = {} as ScoreBreakdown
  for (const k of keys) {
    const v = Number(o[k])
    if (!Number.isFinite(v)) return null
    out[k] = Math.round(clamp(v))
  }
  return out
}

export function composeScore(b: ScoreBreakdown, gates: ScoreGates = {}): ComposedScore {
  const keys = Object.keys(SCORE_WEIGHTS) as Array<keyof ScoreBreakdown>
  const weighted = keys.reduce((sum, k) => sum + b[k] * SCORE_WEIGHTS[k], 0)
  const raw = Math.round(weighted)

  // 闸门：按最狠的一条封顶
  let cap = 100
  let capKey: keyof ScoreBreakdown | null = null
  let capReason = ''
  if (b.compliance < 40) {
    cap = 40
    capKey = 'compliance'
  }
  if (b.differentiation < 30 && cap > 55) {
    cap = 55
    capKey = 'differentiation'
  }
  if (b.customization < 30 && cap > 60) {
    cap = 60
    capKey = 'customization'
  }
  if (b.shipping < 25 && cap > 70) {
    cap = 70
    capKey = 'shipping'
  }
  /*
   * 需求闸门：五维分再高，只要三家分销商目录里都没有同类，
   * 这个"高差异化"就可能是伪需求（也可能只是还没人做，但那是赌博不是生意）。
   * 封顶 55 = 最高只能到 MAYBE，逼业务先找客户确认再投钱。
   */
  if (gates.demandMissing && cap > 55) {
    cap = 55
    capKey = null
    capReason = '分销商目录里没有同类在卖（需求未验证）'
  }

  const score = Math.min(raw, cap)

  const verdict = score >= 75 ? 'GO' : score >= 55 ? 'MAYBE' : 'NO'

  const weakest = keys.reduce((a, k) => (b[k] < b[a] ? k : a), keys[0])
  const note = capReason
    ? `受「${capReason}」封顶`
    : capKey
      ? `受「${DIM_LABEL[capKey]}」封顶（该项 ${b[capKey]} 分）`
      : `最弱一环：${DIM_LABEL[weakest]} ${b[weakest]} 分`

  return { score, verdict, note }
}

/** 档位说明：分数区间对应的动作，给业务侧一个统一口径 */
export function scoreBand(score: number): string {
  if (score >= 85) return '强推：立刻找商家问箱规'
  if (score >= 75) return '可做：值得推进'
  if (score >= 60) return '备选：看客户和价格再定'
  if (score >= 45) return '偏弱：只有特定客户才做'
  return '放弃：不值得投入'
}
