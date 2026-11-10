/**
 * 海外市场探针（两路并行）
 *
 * ① 4imprint 公开 RSS（market-probe 内置）：美国促销礼品头部**分销商**，
 *    RSS 里带真实目录价（"From only $X - $Y"，X 是高数量档单价），用来算价格带。
 *    局限：它只是一个分销商，搜索结果最多约 28 条。
 *
 * ② ASI / ESP 全供应商目录（esp-probe.ts）：supplier.espwebsite.com 是 ASI 旗下
 *    ESP 供应商站群的总入口，等于把各家供应商的目录合起来检索，页面直接给出
 *    "N+ item(s) are found" 的全站匹配数与类目分面计数。**差异化以这一路为主**。
 *
 * 为什么必须两路：早先只用 4imprint，"1 条命中"就被当成"细分薄品类、差异化高"，
 * 但同一个品在 ASI 全网可能有几百上千个供应商在做——结论正好反过来。
 * 现在价格带优先用 4imprint（真实三档目录价），供给密度/竞争用 ESP（全网口径）。
 *
 * 注意：4imprint RSS 每次最多约 28 条；ESP 只抓第一页 20 条 + 平台自报总数
 * （该站分页要走 ASP.NET 回发，URL 参数无效）。两边的总数都按"至少这么多"理解，
 * 所以密度按区间分档，不做线性外推。
 */

import {
  dedupe,
  formOfTitle,
  isRelevant,
  needHits,
  pickMatchTokens,
  priceBandOf,
  round2,
  spreadScoreOf,
  tokensOf,
  type ProductForm,
} from './market-text'
import { probeEspWithDiag, type EspProbeDiag, type EspSnapshot } from './esp-probe'
import {
  demandPriceOf,
  probeDistributors,
  summarizeDemand,
  type DistributorDemand,
  type DistributorSource,
} from './distributor-probe'

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
  /** 4imprint RSS 抓到的原始条数（上限约 28） */
  total: number
  /** 4imprint 标题真正命中产品核心词的条数（剔掉泛匹配噪声） */
  matched: number
  /** 4imprint 密度评分用的同类条数（每次搜索本身就是一次上限 28 的普查） */
  densityCount: number
  /** 判定相关性用的核心词（同款标题必须含其中大部分） */
  matchTokens: string[]
  items: MarketItem[]
  /**
   * 价格带：优先 4imprint 的真实目录价；4imprint 没取到时退回 ESP 样本价。
   * 这是"评价我们的售价贵不贵"的依据。
   */
  price: { min: number; p25: number; median: number; p75: number; max: number } | null
  /** 供给密度分：同款越少越高（ESP 可用时按 ESP 全站口径，否则按 4imprint 28 条口径） */
  densityScore: number
  /** 价格离散分：价格带拉得越开越高 */
  spreadScore: number
  /** 差异化粗估（0-100）：密度 60% + 离散 40%（只看供给，不掺需求） */
  diffEstimate: number
  /** 竞争粗估（0-100）：供给越少分越高；分销商需求越强分越低（3 家都在卖 = 拼价） */
  competitionEstimate: number
  /** 相关性偏低时给界面看的一句话（关键词太泛 / 一条都没命中） */
  relevanceNote?: string
  /** ASI / ESP 全供应商目录那一路的证据（供给侧，差异化主依据；旧数据没有这个字段） */
  esp?: EspSnapshot
  /** 分销商需求侧证据（多家分销商目录：几家在卖、各多少条）。旧数据没有 */
  demand?: DistributorDemand
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
  /** ESP 那一路的诊断（失败原因单独看，避免和 4imprint 混在一起） */
  esp?: EspProbeDiag
  snapshot: MarketSnapshot | null
  /** 整体失败原因（给界面/日志看的一句话） */
  error?: string
}

export interface ProbeOptions {
  /** AI 判断的"同款标题必须含"的英文名词（优先级最高，命中率最准） */
  coreKeywords?: string[]
  /** AI 认出的英文品类名，用于在没给核心词时补足判断依据 */
  productType?: string
  /** 我们自己产品的形态（套装/单件）：形态不同的价格不能直接比 */
  productForm?: ProductForm
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

/** 供给密度（4imprint 28 条口径）：同款条数越多，差异化越低 */
function densityScoreOf(total: number): number {
  if (total <= 4) return 92
  if (total <= 8) return 78
  if (total <= 14) return 62
  if (total <= 22) return 44
  return 28
}

/** 只依赖最小形状，避免 @types/node 版本差异导致 fetch 类型缺失 */
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

interface FourImprintResult {
  perQuery: ProbeDiag['perQuery']
  /** 去重后的原始条数（两条 query 的并集，不是相加） */
  total: number
  items: MarketItem[]
  matchTokens: string[]
  matched: number
  densityCount: number
  price: MarketSnapshot['price']
  relevanceNote?: string
  error?: string
}

/** 4imprint 那一路（原来的全部逻辑，原样保留，只是包成函数方便和 ESP 并行） */
async function probe4imprint(
  clean: string[],
  timeoutMs: number,
  opts: ProbeOptions
): Promise<FourImprintResult> {
  const perQuery: ProbeDiag['perQuery'] = []
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
    return {
      perQuery,
      total: 0,
      items: [],
      matchTokens,
      matched: 0,
      densityCount: 0,
      price: null,
      error,
    }
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
  const price = priceBandOf(basis.map((i) => i.priceMin))

  /*
   * 密度口径：RSS 每条 query 最多约 28 条，所以**每条 query 本身就是一次独立普查**。
   * 取"命中同款条数最多的那次搜索"作为密度依据——不按比例外推。
   */
  const bestMatched = Math.min(28, Math.max(0, ...perQuery.map((p) => p.matched)))
  const densityCount = useRelevant ? bestMatched : Math.min(items.length, 28)

  let relevanceNote: string | undefined
  const tokText = matchTokens.join('/')
  if (matchTokens.length && matched === 0) {
    relevanceNote = `4imprint 搜到的 ${items.length} 条里没有一条标题真含 ${tokText}，价格带按原始结果算`
  } else if (matchTokens.length && !useRelevant) {
    relevanceNote = `4imprint 只有 ${matched} 条标题真含 ${tokText}（样本偏少），密度按原始条数算`
  }

  // 价格低的排前面，方便 AI 看"最狠的竞品是谁"
  const sorted = [...basis].sort((a, b) => a.priceMin - b.priceMin)

  return {
    perQuery,
    total: items.length,
    items: sorted,
    matchTokens,
    matched,
    densityCount,
    price,
    ...(relevanceNote ? { relevanceNote } : {}),
  }
}

/** 带诊断的市场探测：两路并行，失败也能说清失败在哪一路 */
export async function probeWithDiag(
  queries: string[],
  timeoutMs = 9000,
  opts: ProbeOptions = {}
): Promise<ProbeDiag> {
  const clean = dedupe(queries.map((q) => q.trim()).filter(Boolean)).slice(0, 2)
  if (!clean.length) return { queries: [], perQuery: [], snapshot: null, error: '没有可用的英文搜索词' }

  const [four, esp, dist] = await Promise.all([
    probe4imprint(clean, timeoutMs, opts).catch(() => null),
    probeEspWithDiag(clean, timeoutMs, opts).catch((e) => ({
      queries: clean,
      perQuery: [],
      snapshot: null,
      error: (e as Error)?.message ?? 'ESP 探针异常',
    })),
    probeDistributors(clean, timeoutMs, {
      coreKeywords: opts.coreKeywords,
      productType: opts.productType,
      productForm: opts.productForm,
    }).catch(() => null),
  ])

  const fourOk = Boolean(four && four.items.length)
  const espSnap = esp?.snapshot ?? null
  // ESP 只有在"真匹配到了东西"时才拿来定密度；泛匹配兜底页的总数不可信
  const espUsable = Boolean(espSnap && espSnap.total > 0 && !espSnap.fallback)

  if (!fourOk && !espSnap && !dist) {
    return {
      queries: clean,
      perQuery: four?.perQuery ?? [],
      esp,
      snapshot: null,
      error: four?.error ?? esp?.error ?? '所有来源都没取到数据',
    }
  }

  /*
   * 需求侧：4imprint 也是"一家分销商"，并入同一张表一起看。
   * 单看任何一家都会误判——一家没上架不代表没人要，一家上了架也不代表大众需求。
   */
  const fourSource: DistributorSource = {
    id: 'fourimprint',
    name: '4imprint',
    ok: fourOk,
    total: four?.total ?? null,
    sampleSize: four?.total ?? 0,
    matched: four?.matched ?? 0,
    sameFormCount: four && opts.productForm
      ? four.items.filter((i) => formOfTitle(i.title) === opts.productForm).length
      : 0,
    price: four?.price ?? null,
    priceSameForm: null,
    items: (four?.items ?? []).slice(0, 12).map((i) => ({
      title: i.title,
      priceMin: i.priceMin,
      url: i.url,
      form: formOfTitle(i.title),
    })),
    ...(four?.error ? { error: four.error } : {}),
  }
  const demandSources = [fourSource, ...(dist?.sources ?? [])]
  const demandSummary = summarizeDemand(demandSources)
  const demand: DistributorDemand = {
    checked: demandSources.length,
    carriers: demandSummary.carriers,
    bestCount: demandSummary.bestCount,
    demandScore: demandSummary.demandScore,
    note: demandSummary.note,
    price: demandPriceOf(demandSources, opts.productForm),
    sources: demandSources,
    fetchedAt: new Date().toISOString(),
  }
  const demandUsable = demandSources.some((s) => s.ok)

  // 价格带优先 4imprint（真实分销商三档目录价），没有就退 ESP 样本价
  const price = (fourOk ? four!.price : null) ?? espSnap?.price ?? null
  const spreadScore = price ? spreadScoreOf(price.p25, price.p75, price.median) : 50

  /*
   * 密度以 ESP 为准：这是"全 ASI 供应商目录"的口径，而 4imprint 只是其中一家分销商。
   * 早先只用 4imprint 会把"这家没做过"误读成"市场上没人做"，差异化被系统性高估。
   * 只有 ESP 完全取不到（或返回泛匹配兜底）时，才退回 4imprint 的 28 条口径。
   */
  const densityScore = espUsable
    ? espSnap!.densityScore
    : fourOk
      ? densityScoreOf(four!.densityCount)
      : 50
  const diffEstimate = Math.round(densityScore * 0.6 + spreadScore * 0.4)

  /*
   * 竞争 = 供给拥挤 + 需求旺盛。
   * 供给少但三家分销商都在卖 → 说明是成熟大众品，竞争按"拼价"算，不能给高分。
   * 供给少且没人卖 → 竞争压力确实低，但这个"低"会由需求闸门在总分上扣回来，
   * 不能让它伪装成"高差异化好机会"。
   */
  const competitionEstimate = demandUsable
    ? Math.max(0, Math.min(100, Math.round(densityScore * 0.55 + (100 - demand.demandScore) * 0.45)))
    : densityScore

  const notes = [four?.relevanceNote, espSnap?.relevanceNote].filter(Boolean) as string[]
  if (four && !fourOk && espSnap) notes.push('4imprint 没取到数据，价格带按 ESP 样本价算')
  if (!demandSources.some((s) => s.ok)) notes.push('分销商目录这次都没取到，需求侧无数据')

  // 没有 4imprint 条目时，用 ESP 样本顶上，保证 AI 至少看得到竞品标题和价格
  const items: MarketItem[] = fourOk
    ? four!.items.slice(0, 12)
    : (espSnap?.items ?? []).slice(0, 12).map((i) => ({
        title: i.title,
        priceMin: i.priceMin,
        priceMax: i.priceMin,
        url: i.url,
      }))

  return {
    queries: clean,
    perQuery: four?.perQuery ?? [],
    esp,
    snapshot: {
      queries: clean,
      total: four?.total ?? 0,
      matched: four?.matched ?? 0,
      densityCount: four?.densityCount ?? 0,
      matchTokens: four?.matchTokens ?? espSnap?.matchTokens ?? [],
      items,
      price,
      densityScore,
      spreadScore,
      diffEstimate,
      competitionEstimate,
      ...(notes.length ? { relevanceNote: notes.join('；') } : {}),
      ...(espSnap ? { esp: espSnap } : {}),
      ...(demandUsable ? { demand } : {}),
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

/** 供测试/诊断用：把一段标题按同款口径分词 */
export const marketTokensOf = tokensOf
export { round2 }
