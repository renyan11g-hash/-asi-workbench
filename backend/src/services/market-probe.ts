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
  /** 搜到的同款条数（截断到 28 以内） */
  total: number
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
  fetchedAt: string
}

export interface ProbeDiag {
  queries: string[]
  perQuery: Array<{ query: string; ok: boolean; items: number; bytes: number; status?: number; error?: string }>
  snapshot: MarketSnapshot | null
  /** 整体失败原因（给界面/日志看的一句话） */
  error?: string
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
export async function probeWithDiag(queries: string[], timeoutMs = 9000): Promise<ProbeDiag> {
  const clean = queries.map((q) => q.trim()).filter(Boolean).slice(0, 2)
  const perQuery: ProbeDiag['perQuery'] = []
  if (!clean.length) return { queries: [], perQuery, snapshot: null, error: '没有可用的英文搜索词' }

  const seen = new Set<string>()
  const items: MarketItem[] = []
  for (const q of clean) {
    const r = await fetchRss(q, timeoutMs)
    const parsed = r.ok && r.text ? parseRss(r.text) : []
    perQuery.push({
      query: q,
      ok: r.ok,
      items: parsed.length,
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

  const lows = items.map((i) => i.priceMin).sort((a, b) => a - b)
  const price = {
    min: round2(lows[0]),
    p25: round2(quantile(lows, 0.25)),
    median: round2(quantile(lows, 0.5)),
    p75: round2(quantile(lows, 0.75)),
    max: round2(lows[lows.length - 1]),
  }

  const total = Math.min(items.length, 28)
  const densityScore = densityScoreOf(total)
  const spreadScore = spreadScoreOf(price.p25, price.p75, price.median)
  const diffEstimate = Math.round(densityScore * 0.55 + spreadScore * 0.45)

  // 价格低的排前面，方便 AI 看"最狠的竞品是谁"
  const sorted = [...items].sort((a, b) => a.priceMin - b.priceMin)

  return {
    queries: clean,
    perQuery,
    snapshot: {
      queries: clean,
      total,
      items: sorted.slice(0, 12),
      price,
      densityScore,
      spreadScore,
      diffEstimate,
      competitionEstimate: densityScore,
      fetchedAt: new Date().toISOString(),
    },
  }
}

/**
 * 生产路径用的探测：任何失败都返回 null —— 评估流程不因为探测失败而中断。
 */
export async function probeOverseasMarket(queries: string[], timeoutMs = 9000): Promise<MarketSnapshot | null> {
  try {
    const d = await probeWithDiag(queries, timeoutMs)
    return d.snapshot
  } catch {
    return null
  }
}
