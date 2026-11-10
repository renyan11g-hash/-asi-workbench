/**
 * 海外市场探针 ③：分销商需求侧（多家美国分销商目录）
 *
 * 为什么必须有这一路：我们的货最终是卖给**分销商**的，所以"分销商在不在卖这个品、卖多少钱"
 * 比"供应商在不在做"更接近生意的真相。
 * 早先只有 4imprint 一家 —— 一家分销商的采购偏好代表不了市场（它可能只是没谈下这个供应商）。
 *
 * 现在并行看几家公开可搜的分销商目录（都是服务端渲染、能直接解析出标题/价格/链接）：
 *   · 4imprint           —— 在 market-probe.ts（RSS，带真实阶梯价，最多 28 条）
 *   · Quality Logo Products（qlp）—— search.cfm，页面直接给 "17 Items" 总数 + 最低价
 *   · PrintGlobe（printglobe）—— 每张卡片的 aria-label 里带 "标题, Item #货号, Price from $X"
 *
 * 输出的是"需求证据"：几家分销商在卖同类、各多少条、价格带多少。
 * 0 家在卖 → 需求未验证（可能是伪需求，也可能是确实没人做），必须由 AI 在结论里说清楚，
 * 不能因为"供给少"就自动判成高差异化高机会。
 */

import {
  formOfTitle,
  isRelevant,
  needHits,
  pickMatchTokens,
  priceBandOf,
  type ProductForm,
} from './market-text'
import { fetchWithJinaFallback } from './web-fetch'

export interface DistributorItem {
  title: string
  priceMin: number
  url: string
  sku?: string
  /** 商品主图（识图比价用） */
  image?: string
  form: ProductForm
}

export interface DistributorSource {
  id: string
  name: string
  ok: boolean
  /** 这家目录里搜到多少条（平台自报；没有就给 null，用样本条数代替） */
  total: number | null
  sampleSize: number
  /** 样本里命中核心词的条数 */
  matched: number
  /** 命中核心词且形态与我们的产品一致 */
  sameFormCount: number
  price: { min: number; p25: number; median: number; p75: number; max: number } | null
  priceSameForm: { min: number; p25: number; median: number; p75: number; max: number } | null
  items: DistributorItem[]
  error?: string
  via?: 'direct' | 'jina'
}

export interface DistributorDemand {
  /** 统计了几家分销商 */
  checked: number
  /** 有几家在卖同类（matched >= 1） */
  carriers: number
  /** 单家分销商里同类条目最多的条数 */
  bestCount: number
  /** 需求强度分（0-100）：越多分销商在卖、同类越多，说明需求越真实 */
  demandScore: number
  /** 给界面/提示词看的中文结论 */
  note: string
  /** 跨分销商同类价格带（形态优先） */
  price: { min: number; p25: number; median: number; p75: number; max: number } | null
  sources: DistributorSource[]
  fetchedAt: string
}

export interface DistributorProbeOptions {
  coreKeywords?: string[]
  productType?: string
  productForm?: ProductForm
}

type Adapter = {
  id: string
  name: string
  searchUrl: (q: string) => string
  /** 拿到 HTML → 总数 + 卡片 */
  parse: (html: string) => { total: number | null; items: DistributorItem[] }
  looksOk: (html: string) => boolean
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')

const stripTags = (s: string) => decode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const money = (s: string): number => Number(String(s).replace(/[^0-9.]/g, ''))

/** Quality Logo Products：服务端渲染的搜索页，带 "17 Items" 总数 */
export function parseQlp(html: string): { total: number | null; items: DistributorItem[] } {
  const totalRaw = html.match(/class="js-total-results[^"]*"[^>]*>\s*([\d,]+)\s*Items?/)?.[1]
  const total = totalRaw ? Number(totalRaw.replace(/,/g, '')) : null
  const items: DistributorItem[] = []
  const seen = new Set<string>()
  for (const chunk of html.split('<div class="prod-box-cat"').slice(1)) {
    const href = chunk.match(/href="(\/[^"]+\.htm)"/)?.[1] ?? ''
    const title = stripTags(
      chunk.match(/class="prod-box-cat__info-title[^"]*"[^>]*>([^<]{2,120})</)?.[1] ?? ''
    )
    const priceRaw = chunk.match(/class="prod-box__info-price"[^>]*>[\s\S]{0,80}?\$\s*([\d,]+(?:\.\d+)?)/)?.[1] ?? ''
    const price = money(priceRaw)
    if (!title || !(price > 0)) continue
    const key = href || title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    // 主图（识图比价用）
    const imgRaw = chunk.match(/<img[^>]+src="(\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i)?.[1] ?? ''
    items.push({
      title,
      priceMin: price,
      url: href ? `https://www.qualitylogoproducts.com${href}` : '',
      ...(imgRaw ? { image: `https://www.qualitylogoproducts.com${decode(imgRaw)}` } : {}),
      form: formOfTitle(title),
    })
  }
  return { total, items }
}

/**
 * PrintGlobe：卡片就是一条 <a class="product-card-link" aria-label="标题, Item #货号, Price from $X">
 * 站点没给总条数，用样本条数当上限（40 条/页，本身也是一次普查）。
 */
export function parsePrintglobe(html: string): { total: number | null; items: DistributorItem[] } {
  const items: DistributorItem[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/<a class="product-card-link" aria-label="([^"]+)" href="(\/[^"]+)"/g)) {
    const label = decode(m[1])
    const href = m[2]
    // 形如 "Albany Bamboo Notebooks with Pen, Item #JOU0182, Price from $9.32"
    const parts = label.split(/,\s*(?=Item #|Price from)/)
    const title = (parts[0] ?? '').trim()
    const sku = label.match(/Item\s*#\s*([A-Za-z0-9-]+)/)?.[1] ?? ''
    const price = money(label.match(/Price from\s*\$?\s*([\d,]+(?:\.\d+)?)/)?.[1] ?? '')
    if (!title || !(price > 0)) continue
    const key = href || title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    // 卡片里的图片：从锚点位置往后截一段找 <img>
    const at = html.indexOf(m[0])
    const tail = at >= 0 ? html.slice(at, at + 2500) : ''
    const imgRaw = tail.match(/<img[^>]+src="(\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i)?.[1] ?? ''
    items.push({
      title,
      priceMin: price,
      url: href ? `https://www.printglobe.com${href}` : '',
      ...(sku ? { sku } : {}),
      ...(imgRaw ? { image: `https://www.printglobe.com${decode(imgRaw)}` } : {}),
      form: formOfTitle(title),
    })
  }
  return { total: items.length || null, items }
}

const ADAPTERS: Adapter[] = [
  {
    id: 'qlp',
    name: 'Quality Logo Products',
    searchUrl: (q) => `https://www.qualitylogoproducts.com/search.cfm?q=${encodeURIComponent(q)}`,
    parse: parseQlp,
    looksOk: (h) => h.includes('prod-box-cat') || h.includes('js-total-results'),
  },
  {
    id: 'printglobe',
    name: 'PrintGlobe',
    searchUrl: (q) => `https://www.printglobe.com/search?q=${encodeURIComponent(q)}`,
    parse: parsePrintglobe,
    looksOk: (h) => h.includes('product-card-link') || h.includes('search-result-item'),
  },
]

/** 需求强度：几家在卖 + 单家最多同类数（0 家 = 需求未验证，不是"没人竞争"的好事） */
export function distributorDemandScore(carriers: number, checked: number, bestCount: number): number {
  if (!checked) return 50
  if (carriers <= 0) return 20
  if (carriers === 1) return 45
  if (carriers === 2) return 65
  if (bestCount >= 25) return 92
  if (bestCount >= 10) return 84
  return 76
}

/**
 * 把各家分销商的结果汇总成一句结论 + 三个数。
 * 单独导出是因为 market-probe 要把 4imprint 也并进来一起算（它不在适配器列表里）。
 */
export function summarizeDemand(sources: DistributorSource[]): {
  note: string
  carriers: number
  bestCount: number
  demandScore: number
} {
  const { note, carriers, bestCount } = noteOf(sources)
  return { note, carriers, bestCount, demandScore: distributorDemandScore(carriers, sources.length, bestCount) }
}

/** 跨分销商价格带：优先形态一致，样本不够退回全部同类 */
export function demandPriceOf(
  sources: DistributorSource[],
  productForm?: ProductForm
): { min: number; p25: number; median: number; p75: number; max: number } | null {
  const ok = sources.filter((s) => s.ok)
  const sameForm = productForm
    ? ok.flatMap((s) => s.items.filter((i) => i.form === productForm))
    : []
  const all = ok.flatMap((s) => s.items)
  return priceBandOf((sameForm.length >= 3 ? sameForm : all).map((i) => i.priceMin))
}

function noteOf(sources: DistributorSource[]): { note: string; carriers: number; bestCount: number } {
  const ok = sources.filter((s) => s.ok)
  const carriers = ok.filter((s) => s.matched >= 1).length
  const bestCount = Math.max(0, ...ok.map((s) => s.matched))
  const parts = ok.map((s) => `${s.name} ${s.total ?? s.sampleSize} 条${s.matched ? `/同类 ${s.matched}` : ''}`)
  let note: string
  if (!ok.length) {
    note = '分销商目录这次全都没取到，需求侧无数据（不要据此判断有没有人要）'
  } else if (carriers === 0) {
    note = `取到数据的 ${ok.length} 家分销商目录里都没搜到同类（${parts.join(' · ')}）：需求未验证——可能是伪需求，也可能是这个品还没人做，必须在结论里说明`
  } else if (ok.length === 1) {
    note = `只取到 ${ok[0].name} 一家（${parts.join(' · ')}）：需求证据偏薄，别当成全市场结论`
  } else if (carriers === ok.length) {
    note = `取到数据的 ${ok.length} 家分销商都在卖同类（${parts.join(' · ')}）：需求已验证，属于大众品类，竞争按主流打法考虑`
  } else {
    note = `取到数据的 ${ok.length} 家里有 ${carriers} 家在卖同类（${parts.join(' · ')}）：需求偏窄，只有部分渠道接受这个品`
  }
  if (sources.length > ok.length) {
    note += `；共试 ${sources.length} 家，${sources.filter((s) => !s.ok).map((s) => s.name).join('、')} 这次没取到`
  }
  return { note, carriers, bestCount }
}

/**
 * 页面缓存（30 分钟）：批量选品时同一批英文词会被反复用，
 * 每家分销商每词一页 200-800KB，不缓存会把预算全烧在重复请求上。
 */
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 120
const pageCache = new Map<string, { at: number; value: { total: number | null; items: DistributorItem[] } }>()

function cacheGet(key: string) {
  const hit = pageCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    pageCache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key: string, value: { total: number | null; items: DistributorItem[] }) {
  if (pageCache.size >= CACHE_MAX) {
    const oldest = pageCache.keys().next().value
    if (oldest) pageCache.delete(oldest)
  }
  pageCache.set(key, { at: Date.now(), value })
}

/** 清缓存（测试用） */
export function clearDistributorCache() {
  pageCache.clear()
}

/** 跑一家分销商：两条搜索词合并去重 */
async function probeOne(
  adapter: Adapter,
  queries: string[],
  timeoutMs: number,
  matchTokens: string[],
  need: number,
  productForm?: ProductForm
): Promise<DistributorSource> {
  const seen = new Set<string>()
  const items: DistributorItem[] = []
  let total: number | null = null
  let ok = false
  let error: string | undefined
  let via: 'direct' | 'jina' | undefined

  for (const q of queries) {
    const url = adapter.searchUrl(q)
    const cached = cacheGet(url)
    if (cached) {
      ok = true
      if (cached.total != null && (total == null || cached.total > total)) total = cached.total
      for (const it of cached.items) {
        const key = it.url || it.title.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        items.push(it)
      }
      continue
    }

    const r = await fetchWithJinaFallback(url, {
      timeoutMs,
      looksOk: adapter.looksOk,
    })
    if (!r.ok || !r.text) {
      error = r.error ?? '页面没取到'
      via = via ?? r.via
      continue
    }
    ok = true
    via = r.via
    const parsed = adapter.parse(r.text)
    cacheSet(url, parsed)
    if (parsed.total != null && (total == null || parsed.total > total)) total = parsed.total
    for (const it of parsed.items) {
      const key = it.url || it.title.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      items.push(it)
    }
  }

  const matchedItems = items.filter((it) => isRelevant(it.title, matchTokens, need))
  const basis = matchedItems.length >= 3 ? matchedItems : items
  const sameFormItems =
    productForm && productForm !== 'unknown' ? basis.filter((i) => i.form === productForm) : []

  return {
    id: adapter.id,
    name: adapter.name,
    ok,
    total,
    sampleSize: items.length,
    matched: matchedItems.length,
    sameFormCount: sameFormItems.length,
    price: priceBandOf(basis.map((i) => i.priceMin)),
    priceSameForm: sameFormItems.length >= 3 ? priceBandOf(sameFormItems.map((i) => i.priceMin)) : null,
    items: [...basis].sort((a, b) => a.priceMin - b.priceMin).slice(0, 12),
    ...(error ? { error } : {}),
    ...(via ? { via } : {}),
  }
}

/**
 * 跑全部分销商（并行）。任何一家失败都不影响其它家，也不影响评估。
 */
export async function probeDistributors(
  queries: string[],
  timeoutMs = 9000,
  opts: DistributorProbeOptions = {}
): Promise<DistributorDemand> {
  const clean = queries.map((q) => q.trim()).filter(Boolean).slice(0, 2)
  const matchTokens = pickMatchTokens(clean, opts.coreKeywords ?? [], opts.productType)
  const need = needHits(matchTokens)

  const sources = clean.length
    ? await Promise.all(
        ADAPTERS.map((a) =>
          probeOne(a, clean, timeoutMs, matchTokens, need, opts.productForm).catch(
            (e): DistributorSource => ({
              id: a.id,
              name: a.name,
              ok: false,
              total: null,
              sampleSize: 0,
              matched: 0,
              sameFormCount: 0,
              price: null,
              priceSameForm: null,
              items: [],
              error: (e as Error)?.message ?? '探针异常',
            })
          )
        )
      )
    : []

  const { note, carriers, bestCount, demandScore } = summarizeDemand(sources)

  return {
    checked: sources.length,
    carriers,
    bestCount,
    demandScore,
    note,
    price: demandPriceOf(sources, opts.productForm),
    sources,
    fetchedAt: new Date().toISOString(),
  }
}
