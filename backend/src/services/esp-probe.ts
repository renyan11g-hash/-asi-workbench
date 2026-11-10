/**
 * 海外市场探针 ②：ASI / ESP 全供应商目录（supplier.espwebsite.com）
 *
 * 为什么必须有这一路：4imprint 只是**一个分销商**的目录。它的搜索结果最多 28 条，
 * 而且只覆盖自己采购过的品。拿它判断"这个品类有没有人做"会系统性高估差异化——
 * 4imprint 上 1 条命中，不代表 ASI 全网只有 1 个供应商在做。
 *
 * supplier.espwebsite.com 是 ASI 旗下 ESP 供应商站群的总入口，等于把各家供应商目录
 * 合在一起检索。页面上直接给出三样硬数据（都是服务端渲染，不用 JS）：
 *   1. "N+ item(s) are found"  → 全站匹配总数（ASCII 通配 + 就是"至少这么多"）
 *   2. 左侧 Category 分面计数   → 匹配结果里各 ASI 类目各有多少（平台自己的分类口径）
 *   3. 前 20 条产品卡片        → 标题 / 供应商货号 / 高数量档目录价 / 详情页链接
 *
 * 所以差异化以这一路为主，4imprint 只作为"这一家分销商切了多少"的补充证据。
 *
 * 2026-11-10 实测：该站是 ASP.NET WebForms，分页要走 __doPostBack（带 __VIEWSTATE），
 * 用 URL 参数翻页无效。因此只抓第一页（20 条）+ 平台自报总数，不翻页——
 * 20 条足够算价格四分位，总数用平台给的那个数，不做线性外推。
 */

import { isRelevant, needHits, pickMatchTokens, priceBandOf, tokensOf } from './market-text'

export interface EspItem {
  title: string
  /** 供应商货号（如 B-8298-T） */
  productNo: string
  /** 高数量档目录价（页面上 "$X and up" 的 X） */
  priceMin: number
  /** 产品详情页（可直接点开看竞品） */
  url: string
  /** 卡片上的短描述（截断，仅用于给 AI 判断同款） */
  description?: string
}

export interface EspCategory {
  name: string
  count: number
}

export interface EspSnapshot {
  queries: string[]
  /** 全站匹配总数（页面 "N+ item(s) are found"，天生就是"至少"口径） */
  total: number
  /** 每条搜索词各自匹配到多少（AI 看这个才知道哪个词更具体） */
  byQuery: Array<{ query: string; total: number; matched: number; sampleSize: number }>
  /** 前 20 条样本里标题真命中核心词的条数 */
  matchedSample: number
  /** 样本条数（通常 20） */
  sampleSize: number
  /** 判定相关性用的核心词 */
  matchTokens: string[]
  /** 匹配结果的 ASI 类目分布（前 8） */
  categories: EspCategory[]
  items: EspItem[]
  price: { min: number; p25: number; median: number; p75: number; max: number } | null
  /** 供给密度分：全站匹配越多越低（0-100） */
  densityScore: number
  /** 站点没给真匹配、返回了热门兜底列表 */
  fallback: boolean
  relevanceNote?: string
  fetchedAt: string
}

export interface EspProbeDiag {
  queries: string[]
  perQuery: Array<{
    query: string
    ok: boolean
    /** 平台自报匹配总数 */
    total: number | null
    items: number
    /** 其中标题命中核心词的条数 */
    matched: number
    bytes: number
    status?: number
    error?: string
    /** 这一页是怎么拿到的：直连 / jina 兜底 / 缓存 */
    via?: 'direct' | 'jina' | 'cache'
  }>
  snapshot: EspSnapshot | null
  error?: string
}

export interface EspProbeOptions {
  coreKeywords?: string[]
  productType?: string
}

const ENDPOINT = 'https://supplier.espwebsite.com/ProductResults/?SearchTerms='
const DETAIL_BASE = 'https://supplier.espwebsite.com/ProductDetails/?productId='
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

const stripTags = (s: string) => decode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * 解析搜索结果页。
 * 每个产品是一个 `..._ItemContainer"` 区块，里面既有隐藏的 productId，也有 prodTile 卡片。
 * 用区块切分而不是全局抓三个正则再按顺序对齐——少一条价格就整体错位。
 */
export function parseEspResults(html: string): {
  total: number | null
  categories: EspCategory[]
  items: EspItem[]
} {
  const countRaw = html.match(/ltAlgoliaProductCount[^>]*>\s*([\d,]+)\s*\+?\s*</)?.[1]
  const total = countRaw ? Number(countRaw.replace(/,/g, '')) : null

  const categories: EspCategory[] = []
  const seenCat = new Set<string>()
  /*
   * 类目分面写在 onclick 的 JS 里。直连拿到的 HTML 是裸引号，
   * 但经 jina 渲染回来后引号会被转义成 &quot;（机房 IP 直连会被 Cloudflare 挡，jina 是主通路），
   * 所以先把实体还原再匹配，否则 ESP 这一路会永远没有类目分布。
   */
  const catText = html.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  for (const m of catText.matchAll(/SelectDimStats\("CTGR","([^"]+)","(\d+)"\)/g)) {
    const name = stripTags(m[1])
    const count = Number(m[2])
    if (!name || !Number.isFinite(count) || count <= 0 || seenCat.has(name)) continue
    seenCat.add(name)
    categories.push({ name, count })
  }

  const items: EspItem[] = []
  const seen = new Set<string>()
  for (const chunk of html.split('_ItemContainer"').slice(1)) {
    const productId = chunk.match(/productId"[^>]*value="(\d+)"/)?.[1] ?? ''
    const title = stripTags(chunk.match(/lblTVProdName"[^>]*title="([^"]*)"/)?.[1] ?? '')
    if (!title) continue
    const priceRaw = chunk.match(/lblPrice"[^>]*>\s*\$\s*([\d,]+(?:\.\d+)?)/)?.[1] ?? ''
    const price = Number(priceRaw.replace(/,/g, ''))
    if (!Number.isFinite(price) || price <= 0) continue
    const productNo = stripTags(chunk.match(/litProdNo"[^>]*>([^<]*)</)?.[1] ?? '')
    const description = stripTags(chunk.match(/<div class="prodDescr">([\s\S]*?)<\/div>/)?.[1] ?? '')
    const key = productId || title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      title,
      productNo: productNo.slice(0, 40),
      priceMin: Math.round(price * 1000) / 1000,
      url: productId ? `${DETAIL_BASE}${productId}&PCUrl=1` : '',
      ...(description ? { description: description.slice(0, 240) } : {}),
    })
  }

  return { total, categories: categories.slice(0, 8), items }
}

/**
 * 供给密度：全站匹配总数越多，差异化越低。
 * 分档而不是线性映射——平台给的是"至少 N 条"的粗数，用连续函数会假装精确。
 */
export function espDensityScore(total: number): number {
  if (total <= 0) return 96
  if (total <= 100) return 88
  if (total <= 300) return 76
  if (total <= 1000) return 62
  if (total <= 3000) return 48
  if (total <= 10000) return 34
  return 22
}

type SimpleResponse = { ok: boolean; status?: number; text(): Promise<string> }
type SimpleFetch = (
  url: string,
  init?: { signal?: unknown; headers?: Record<string, string> }
) => Promise<SimpleResponse>

const nativeFetch = (globalThis as unknown as { fetch?: SimpleFetch }).fetch

/**
 * 单个搜索词的页面缓存（30 分钟）。
 * 批量选品时同一个英文词会被反复用（同一款产品重评、同类产品排队），
 * 每次都打一遍 350KB 的页面既慢又容易被限流。
 */
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 200
const pageCache = new Map<string, { at: number; value: { total: number | null; categories: EspCategory[]; items: EspItem[] } }>()

function readCache(key: string) {
  const hit = pageCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    pageCache.delete(key)
    return null
  }
  return hit.value
}

function writeCache(key: string, value: { total: number | null; categories: EspCategory[]; items: EspItem[] }) {
  if (pageCache.size >= CACHE_MAX) {
    const oldest = pageCache.keys().next().value
    if (oldest) pageCache.delete(oldest)
  }
  pageCache.set(key, { at: Date.now(), value })
}

/** 清缓存（测试用） */
export function clearEspCache() {
  pageCache.clear()
}

/**
 * 抓一页搜索结果。
 *
 * 2026-11-10 实测：从 Render（机房 IP）直连 supplier.espwebsite.com 会被 Cloudflare 挡成
 * HTTP 403，而本机（住宅 IP）直连是 200。所以这里先直连，失败就退到 r.jina.ai 渲染服务
 * （带 x-return-format: html 时它返回的是**原始 HTML**，解析逻辑一行都不用改）。
 * 这类站点没有公开 API，jina 是当前唯一稳定通路；它失败时评估照常进行，只是少了这一路证据。
 */
const JINA_PREFIX = 'https://r.jina.ai/'

type FetchOutcome = { ok: boolean; text?: string; status?: number; error?: string; via: 'direct' | 'jina' }

async function fetchOnce(
  url: string,
  timeoutMs: number,
  via: 'direct' | 'jina'
): Promise<FetchOutcome> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await nativeFetch!(url, {
      signal: ctrl.signal,
      headers:
        via === 'jina'
          ? { 'User-Agent': UA, Accept: 'text/html', 'x-return-format': 'html' }
          : {
              'User-Agent': UA,
              Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
    })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, via }
    const text = await res.text()
    return { ok: true, status: res.status, text, via }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    return { ok: false, error: /abort/i.test(msg) ? `超时（${timeoutMs}ms）` : msg, via }
  } finally {
    clearTimeout(timer)
  }
}

/** 页面到底是不是搜索结果页（防止把 Cloudflare 挑战页当成"0 条结果"） */
const looksLikeResultsPage = (html: string) =>
  html.includes('ltAlgoliaProductCount') || html.includes('RptProductsGrid') || html.includes('prodTile')

async function fetchPage(query: string, timeoutMs: number): Promise<FetchOutcome> {
  if (!nativeFetch) return { ok: false, error: '运行时没有 fetch（Node 版本过低）', via: 'direct' }
  const target = ENDPOINT + encodeURIComponent(query) + '&PCUrl=1'

  const direct = await fetchOnce(target, timeoutMs, 'direct')
  if (direct.ok && direct.text && looksLikeResultsPage(direct.text)) return direct

  // 直连被挡 / 拿到的是挑战页 → 走 jina 渲染（给足时间，它要自己去抓一次）
  const jina = await fetchOnce(JINA_PREFIX + target, Math.max(timeoutMs, 15000), 'jina')
  if (jina.ok && jina.text && looksLikeResultsPage(jina.text)) return jina

  // 都不行：优先报告直连的状态码（更能说明是被挡还是页面变了）
  if (direct.ok) return { ...jina, error: jina.error ?? direct.error }
  return direct.error ? direct : jina
}

/** 带诊断的 ESP 探测：失败也能说清失败在哪一步 */
export async function probeEspWithDiag(
  queries: string[],
  timeoutMs = 9000,
  opts: EspProbeOptions = {}
): Promise<EspProbeDiag> {
  const clean = queries.map((q) => q.trim()).filter(Boolean).slice(0, 2)
  const perQuery: EspProbeDiag['perQuery'] = []
  if (!clean.length) return { queries: [], perQuery, snapshot: null, error: '没有可用的英文搜索词' }

  const matchTokens = pickMatchTokens(clean, opts.coreKeywords ?? [], opts.productType)
  const need = needHits(matchTokens)

  const seen = new Set<string>()
  const items: EspItem[] = []
  let total = 0
  let categories: EspCategory[] = []

  /*
   * 两条搜索词并行抓：jina 兜底要 10-20 秒，串行会拖到 40 秒，直接卡住评估。
   * 抓到的结果按 clean 的原顺序合并，保证"第一条更具体"的口径不变。
   */
  const fetched = await Promise.all(
    clean.map(async (q) => {
      const cached = readCache(q)
      if (cached) return { q, parsed: cached, bytes: 0, status: 200, ok: true, via: 'cache' as const }
      const r = await fetchPage(q, timeoutMs)
      const parsed = r.ok && r.text ? parseEspResults(r.text) : { total: null, categories: [], items: [] }
      if (r.ok && (parsed.items.length || parsed.total != null)) writeCache(q, parsed)
      return { q, parsed, bytes: r.text?.length ?? 0, status: r.status, ok: r.ok, error: r.error, via: r.via }
    })
  )

  for (const f of fetched) {
    perQuery.push({
      query: f.q,
      ok: f.ok,
      total: f.parsed.total,
      items: f.parsed.items.length,
      matched: f.parsed.items.filter((it) => isRelevant(it.title, matchTokens, need)).length,
      bytes: f.bytes,
      status: f.status,
      ...(f.error ? { error: f.error } : {}),
      via: f.via,
    })
    // 密度取各条搜索词里**匹配最多**的那一次：宁可按"竞争更激烈"算，不再高估差异化
    if (typeof f.parsed.total === 'number' && f.parsed.total > total) total = f.parsed.total
    // 类目分布用第一条有结果的那次搜索（它是更具体的那个词）
    if (!categories.length && f.parsed.categories.length) categories = f.parsed.categories
    for (const it of f.parsed.items) {
      const key = it.url || it.title.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      items.push(it)
    }
  }

  if (!items.length && !total) {
    const firstErr = perQuery.find((p) => !p.ok || p.items === 0)
    const error = firstErr?.error
      ? firstErr.error
      : firstErr?.ok && firstErr.bytes > 0
        ? `${firstErr.query}: 页面抓到了 ${firstErr.bytes} 字节，但没解析出产品（页面结构可能变了）`
        : '没有解析到任何产品'
    return { queries: clean, perQuery, snapshot: null, error }
  }

  const matchedItems = items.filter((it) => isRelevant(it.title, matchTokens, need))
  const matchedSample = matchedItems.length
  // 少于 3 条就当"没筛住"，价格带用全量样本，避免样本太窄得出极端结论
  const useRelevant = matchedSample >= 3
  const basis = useRelevant ? matchedItems : items
  const price = priceBandOf(basis.map((i) => i.priceMin))

  /*
   * 兜底识别：站点对完全没命中的词会返回 0 条（total=0）；
   * 但 word 被拆开泛匹配时（如 "not a product"）会给一大坨热门品——
   * 这种情况下 total 是虚的，必须在 note 里说清楚，别让 AI 把它当成"竞争激烈"的证据。
   */
  const fallback = matchedSample === 0
  const densityScore = espDensityScore(total)

  let relevanceNote: string | undefined
  const tokText = matchTokens.join('/')
  if (total === 0) {
    relevanceNote = `ESP（全 ASI 供应商目录）搜「${clean.join(' | ')}」没有匹配到任何产品`
  } else if (fallback) {
    relevanceNote = `ESP 匹配到 ${total} 条，但前 ${items.length} 条标题都不含 ${tokText || '核心词'}，像是泛匹配兜底结果，密度不可信`
  } else if (items.length >= 8 && matchedSample / items.length < 0.3) {
    relevanceNote = `ESP 匹配 ${total} 条，前 ${items.length} 条里仅 ${matchedSample} 条是同类（${Math.round(
      (matchedSample / items.length) * 100
    )}%），词偏泛`
  }

  const sorted = [...basis].sort((a, b) => a.priceMin - b.priceMin)

  return {
    queries: clean,
    perQuery,
    snapshot: {
      queries: clean,
      total,
      byQuery: perQuery.map((p) => ({
        query: p.query,
        total: p.total ?? 0,
        matched: p.matched,
        sampleSize: p.items,
      })),
      matchedSample,
      sampleSize: items.length,
      matchTokens,
      categories,
      items: sorted.slice(0, 12),
      price,
      densityScore,
      fallback,
      ...(relevanceNote ? { relevanceNote } : {}),
      fetchedAt: new Date().toISOString(),
    },
  }
}

/** 生产路径用：任何失败都返回 null —— 评估流程不因为 ESP 挂掉而中断 */
export async function probeEsp(
  queries: string[],
  timeoutMs = 9000,
  opts: EspProbeOptions = {}
): Promise<EspSnapshot | null> {
  try {
    const d = await probeEspWithDiag(queries, timeoutMs, opts)
    return d.snapshot
  } catch {
    return null
  }
}

/** 只给测试用：把一段标题按同一套口径判断同款 */
export const espRelevanceTokens = tokensOf
