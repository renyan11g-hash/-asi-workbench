/**
 * 海外市场探针的公共文本工具（4imprint 与 ESP 两个来源共用）。
 *
 * 为什么要抽出来：两个探针的"相关性过滤"必须是同一套口径。
 * 如果 4imprint 用一套停用词、ESP 用另一套，"同款条数"就不可比，
 * 差异化评分会在两个来源之间来回漂移。
 */

/** 英文停用词：促销礼品标题几乎条条都有，不能用来判断"是不是同款" */
export const EN_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'of', 'to', 'in', 'on', 'at', 'by', 'a', 'an',
  'new', 'set', 'pcs', 'pc', 'pack', 'piece', 'pieces', 'custom', 'logo', 'printed', 'print',
  'promotional', 'promo', 'product', 'item', 'style', 'type', 'high', 'quality', 'large',
  'small', 'mini', 'portable', 'multi', 'function', 'functional', 'your', 'you', 'our',
  'all', 'one', 'two', 'plus', 'deluxe', 'classic', 'premium', 'basic', 'value', 'easy',
  'travel', // 太泛：行李箱/收纳/洗漱/颈枕标题里都有，单靠它不算同款
])

/** 粗粒度单复数归一：bags→bag，boxes→box，toiletries→toiletry */
export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
  if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

export function tokensOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !EN_STOP.has(w))
    .map(stem)
}

export const dedupe = (list: string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of list) {
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/**
 * 挑一套"同款标题必须命中"的核心词。
 * 优先用 AI 给的 coreKeywords（它认得这个品类的必备名词）；
 * 没给就取最长的那一条搜索词 / 品类名的实词——只用单一短语，保证阈值口径一致。
 */
export function pickMatchTokens(queries: string[], coreKeywords: string[], productType?: string): string[] {
  const fromAi = dedupe(coreKeywords.flatMap(tokensOf))
  if (fromAi.length >= 2) return fromAi.slice(0, 8)

  const phrases = [...queries, ...(productType ? [productType] : [])]
  let best: string[] = []
  for (const p of phrases) {
    const t = tokensOf(p)
    if (t.length > best.length) best = t
  }
  return dedupe(best).slice(0, 6)
}

/** 需要命中几个核心词才算同款：短词全中，长词 60% */
export function needHits(tokens: string[]): number {
  if (!tokens.length) return 1
  return tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.6)
}

export function isRelevant(title: string, tokens: string[], need: number): boolean {
  if (!tokens.length) return true
  const t = new Set(tokensOf(title))
  let hit = 0
  for (const tok of tokens) if (t.has(tok)) hit++
  return hit >= need
}

export const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const next = sorted[base + 1] ?? sorted[base]
  return sorted[base] + rest * (next - sorted[base])
}

export const round2 = (v: number) => Math.round(v * 100) / 100

/** 价格带统计（四分位）；空数组返回 null */
export function priceBandOf(values: number[]): { min: number; p25: number; median: number; p75: number; max: number } | null {
  const lows = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  if (!lows.length) return null
  return {
    min: round2(lows[0]),
    p25: round2(quantile(lows, 0.25)),
    median: round2(quantile(lows, 0.5)),
    p75: round2(quantile(lows, 0.75)),
    max: round2(lows[lows.length - 1]),
  }
}

/** 价格离散度：(p75-p25)/median，价格带拉得开说明市场接受溢价 */
export function spreadScoreOf(p25: number, p75: number, median: number): number {
  if (!(median > 0)) return 50
  const spread = (p75 - p25) / median
  if (spread >= 0.9) return 85
  if (spread >= 0.6) return 70
  if (spread >= 0.4) return 56
  if (spread >= 0.25) return 42
  return 30
}
