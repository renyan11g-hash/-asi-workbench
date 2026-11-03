/**
 * 海外市场探针（4imprint 公开 RSS）
 *
 * 为什么用它：评估最怕"AI 拍脑袋"。4imprint 是美国促销礼品头部平台，
 * 它的搜索结果里带着**真实目录价**（"From only $X - $Y"，X 是高数量档的单价）。
 * 把我们自己的品换算成英文词去搜一下，就能拿到三件事实：
 *   1. 同款有多少条        → 供给密度（差异化 / 竞争的直接证据）
 *   2. 价格区间怎么分布    → 价格带是否拉得开（能不能做溢价）
 *   3. 具体竞品标题/价格   → 直接喂给 AI 对比
 *
 * 注意：RSS 每次最多约 28 条，条数是"至少这么多"，不是全量。
 * 所以密度评分按区间分档，不做线性外推。
 *
 * 2026-11-03：Render 上探针返回空，需要外部可诊断。
 * 因此把"抓取过程"也返回出来（probeWithDiag），并开放 /api/health/market-probe?q= 便于远程排查。
 */

export interface MarketItem {
  title: string
  /** 高数量档的目录单价（From only $X 的 X） */
  priceMin: number
  /** 低数量档的目录单价 */
  priceMax: number
  url: string
}

export interface MarketSnapshot {
  queries: string[]
  /** RSS 抓到的原始条数（4imprint 上限约 28，代表这个品类的供给总量感） */
  total: number
  /** 标题真正命中产品核心词的条数（剔掉 4imprint 的泛匹配噪声） */
  matched: number
  /** 密度评分用的同类条数：取命中最多的一次搜索（每次搜索本身就是一次上限 28 的普查） */
  densityCount: number
  /** 判定相关性用的核心词（同款标题必须含其中大部分） */
  matchTokens: string[]
  items: MarketItem[]
  price: { min: number; p25: number; median: number; p75: number; max: number } | null
  /** 供给密度分：同款越少越高 */
  densityScore: number
  /** 价格离散分：价格带拉得越开越高 */
  spreadScore: number
  /** 差异化粗估（0-100）：密度 55% + 离散 45% */
  diffEstimate: number
  /** 竞争粗估（0-100）：等同于密度分（同款少 = 竞争弱 = 分高） */
  competitionEstimate: number
  /** 相关性偏低时给界面看的一句话（关键词太泛 / 一条都没命中） */
  relevanceNote?: string
  fetchedAt: string
}

export interface ProbeDiag {
  queries: string[]
  perQuery: Array<{
    query: string
    ok: boolean
    items: number
    /** 其中标题命中核心词的条数 */
    matched: number
    bytes: number
    status?: number
    error?: string
  }>
  snapshot: MarketSnapshot | null
  /** 整体失败原因（给界面/日志看的一句话） */
  error?: string
}

export interface ProbeOptions {
  /** AI 判断的"同款标题必须含"的英文名词（优先级最高，命中率最准） */
  coreKeywords?: string[]
  /** AI 认出的英文品类名，用于在没给核心词时补足判断依据 */
  productType?: string
}

const ENDPOINT = 'https://www.4imprint.com/rss/search?searchterm='

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

const stripTags = (s: string) => decode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

function parseRss(xml: string): MarketItem[] {
  const out: MarketItem[] = []
  for (const block of xml.split('<item>').slice(1)) {
    const url = (block.match(/<link>([^<]+)<\/link>/)?.[1] ?? '').trim()
    const title = stripTags(block.match(/<title>([^<]*)<\/title>/)?.[1] ?? '')
    const desc = block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ''
    if (!title) continue
    // 描述里可能同时有 "Original Price from $a - $b" 和 "Sale Price from only $c - $d"，
    // 取最后一组（促销价才是买家实际看到的价）
    const prices = [...desc.matchAll(/\$\s*([\d.]+)\s*-\s*\$\s*([\d.]+)/g)]
    if (!prices.length) continue
    const last = prices[prices.length - 1]
    const a = Number(last[1])
    const b = Number(last[2])
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue
    out.push({ title, priceMin: Math.min(a, b), priceMax: Math.max(a, b), url })
  }
  return out
}

const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const next = sorted[base + 1] ?? sorted[base]
  return sorted[base] + rest * (next - sorted[base])
}

const round2 = (v: number) => Math.round(v * 100) / 100

/** 供给密度：同款条数越多，差异化越低 */
function densityScoreOf(total: number): number {
  if (total <= 4) return 92
  if (total <= 8) return 78
  if (total <= 14) return 62
  if (total <= 22) return 44
  return 28
}

/** 价格离散度：(p75-p25)/median，价格带拉得开说明市场接受溢价 */
function spreadScoreOf(p25: number, p75: number, median: number): number {
  if (!(median > 0)) return 50
  const spread = (p75 - p25) / median
  if (spread >= 0.9) return 85
  if (spread >= 0.6) return 70
  if (spread >= 0.4) return 56
  if (spread >= 0.25) return 42
  return 30
}

/*
 * ---------- 相关性过滤 ----------
 *
 * 为什么要它：4imprint 的搜索是**泛匹配**。搜 "travel organizer" 会返回
 * Curvy Pen（圆珠笔）、Coin Pouch（硬币袋）这类完全不相干的品——因为单词被拆开匹配了。
 * 如果直接拿这 28 条算价格离散度，噪声会被当成"市场价位分层丰富"，差异化被系统性高估。
 * 所以先用"同款标题必须含有几个核心词"筛一遍，只拿真正同款的算密度和价格带。
 */

/** 英文停用词：促销礼品标题几乎条条都有，不能用来判断"是不是同款" */
const EN_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'of', 'to', 'in', 'on', 'at', 'by', 'a', 'an',
  'new', 'set', 'pcs', 'pc', 'pack', 'piece', 'pieces', 'custom', 'logo', 'printed', 'print',
  'promotional', 'promo', 'product', 'item', 'style', 'type', 'high', 'quality', 'large',
  'small', 'mini', 'portable', 'multi', 'function', 'functional', 'your', 'you', 'our',
  'all', 'one', 'two', 'plus', 'deluxe', 'classic', 'premium', 'basic', 'value', 'easy',
  'travel', // 太泛：行李箱/收纳/洗漱/颈枕标题里都有，单靠它不算同款
])

/** 粗粒度单复数归一：bags→bag，boxes→box，toiletries→toiletry */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
  if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

function tokensOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !EN_STOP.has(w))
    .map(stem)
}

const dedupe = (list: string[]): string[] => {
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
function pickMatchTokens(queries: string[], coreKeywords: string[], productType?: string): string[] {
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
function needHits(tokens: string[]): number {
  if (!tokens.length) return 1
  return tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.6)
}

function isRelevant(title: string, tokens: string[], need: number): boolean {
  if (!tokens.length) return true
  const t = new Set(tokensOf(title))
  let hit = 0
  for (const tok of tokens) if (t.has(tok)) hit++
  return hit >= need
}

/** 只依赖最小形状，避免 @types/node 版本差异导致 fetch 类型缺失（本地没有 tsc 可验） */
type SimpleResponse = { ok: boolean; status?: number; text(): Promise<string> }
type SimpleFetch = (
  url: string,
  init?: { signal?: unknown; headers?: Record<string, string> }
) => Promise<SimpleResponse>

const nativeFetch = (globalThis as unknown as { fetch?: SimpleFetch }).fetch

async function fetchRss(
  query: string,
  timeoutMs: number
): Promise<{ ok: boolean; text?: string; status?: number; error?: string }> {
  if (!nativeFetch) return { ok: false, error: '运行时没有 fetch（Node 版本过低）' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await nativeFetch(ENDPOINT + encodeURIComponent(query), {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      },
    })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    const text = await res.text()
    return { ok: true, status: res.status, text }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    return { ok: false, error: /abort/i.test(msg) ? `超时（${timeoutMs}ms）` : msg }
  } finally {
    clearTimeout(timer)
  }
}

/** 带诊断的市场探测：失败也能说清失败在哪一步 */
export async function probeWithDiag(
  queries: string[],
  timeoutMs = 9000,
  opts: ProbeOptions = {}
): Promise<ProbeDiag> {
  const clean = queries.map((q) => q.trim()).filter(Boolean).slice(0, 2)
  const perQuery: ProbeDiag['perQuery'] = []
  if (!clean.length) return { queries: [], perQuery, snapshot: null, error: '没有可用的英文搜索词' }

  const seen = new Set<string>()
  const items: MarketItem[] = []
  // 核心词先算出来，方便在抓取时直接统计每条 query 的命中数
  const matchTokens = pickMatchTokens(clean, opts.coreKeywords ?? [], opts.productType)
  const need = needHits(matchTokens)
  for (const q of clean) {
    const r = await fetchRss(q, timeoutMs)
    const parsed = r.ok && r.text ? parseRss(r.text) : []
    perQuery.push({
      query: q,
      ok: r.ok,
      items: parsed.length,
      matched: parsed.filter((it) => isRelevant(it.title, matchTokens, need)).length,
      bytes: r.text?.length ?? 0,
      status: r.status,
      error: r.error,
    })
    for (const it of parsed) {
      const key = it.title.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      items.push(it)
    }
  }

  if (!items.length) {
    const firstErr = perQuery.find((p) => !p.ok || p.items === 0)
    const error = firstErr?.error
      ? firstErr.error
      : firstErr?.ok && firstErr.bytes > 0
        ? `${firstErr.query}: 页面抓到了 ${firstErr.bytes} 字节，但没解析出带价格的商品`
        : '没有解析到任何商品'
    return { queries: clean, perQuery, snapshot: null, error }
  }

  /*
   * 相关性过滤：4imprint 泛匹配会混进大量不相干的品（搜 organizer 出来圆珠笔）。
   * 筛完只拿真同款算价格带和密度；一条都没筛出来就退回全量，并在 relevanceNote 里说清楚。
   */
  const relevant = items.filter((it) => isRelevant(it.title, matchTokens, need))
  const matched = relevant.length
  // 少于 3 条就当"没筛住"，用全量，避免样本太窄得出极端结论
  const useRelevant = matched >= 3
  const basis = useRelevant ? relevant : items

  const lows = basis.map((i) => i.priceMin).sort((a, b) => a - b)
  const price = {
    min: round2(lows[0]),
    p25: round2(quantile(lows, 0.25)),
    median: round2(quantile(lows, 0.5)),
    p75: round2(quantile(lows, 0.75)),
    max: round2(lows[lows.length - 1]),
  }

  /*
   * 密度口径：RSS 每条 query 最多约 28 条，所以**每条 query 本身就是一次独立普查**。
   * 取"命中同款条数最多的那次搜索"作为密度依据——不按比例外推：
   *   · 该词只返回 16 条（没到上限）→ 这 16 条就是全量，命中 4 条就是真有 4 条同类；
   *   · 该词返回满 28 条（被截断）→ 28 条里命中 11 条，同类密度就是 11/28。
   * 早先按"总命中率折算"会被两条 query 合并后的分母摊薄，密度被系统性高估。
   */
  const bestMatched = Math.min(28, Math.max(0, ...perQuery.map((p) => p.matched)))
  const densityCount = useRelevant ? bestMatched : Math.min(items.length, 28)

  const densityScore = densityScoreOf(densityCount)
  const spreadScore = spreadScoreOf(price.p25, price.p75, price.median)
  const diffEstimate = Math.round(densityScore * 0.55 + spreadScore * 0.45)

  let relevanceNote: string | undefined
  const tokText = matchTokens.join('/')
  if (matchTokens.length && matched === 0) {
    relevanceNote = `「${clean.join(' | ')}」搜到的 ${items.length} 条里没有一条标题真含 ${tokText}，价格带按原始结果算，差别仅供参考`
  } else if (matchTokens.length && !useRelevant) {
    relevanceNote = `只有 ${matched} 条标题真含 ${tokText}（样本偏少），密度按原始条数算`
  } else if (useRelevant && items.length >= 8 && matched / items.length < 0.25) {
    relevanceNote = `${items.length} 条里仅 ${matched} 条是同类（${Math.round((matched / items.length) * 100)}%），说明这个词的搜索结果很杂；密度只按命中条数算`
  }

  // 价格低的排前面，方便 AI 看"最狠的竞品是谁"
  const sorted = [...basis].sort((a, b) => a.priceMin - b.priceMin)

  return {
    queries: clean,
    perQuery,
    snapshot: {
      queries: clean,
      total: items.length,
      matched,
      densityCount,
      matchTokens,
      items: sorted.slice(0, 12),
      price,
      densityScore,
      spreadScore,
      diffEstimate,
      competitionEstimate: densityScore,
      ...(relevanceNote ? { relevanceNote } : {}),
      fetchedAt: new Date().toISOString(),
    },
  }
}

/**
 * 生产路径用的探测：任何失败都返回 null —— 评估流程不因为探测失败而中断。
 */
export async function probeOverseasMarket(
  queries: string[],
  timeoutMs = 9000,
  opts: ProbeOptions = {}
): Promise<MarketSnapshot | null> {
  try {
    const d = await probeWithDiag(queries, timeoutMs, opts)
    return d.snapshot
  } catch {
    return null
  }
}
