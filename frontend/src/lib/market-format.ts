/**
 * 海外同款证据的统一展示格式。
 *
 * 为什么要单独抽出来：三个页面（选品预估 / 产品信息预填 / 产品库）都要显示同一句话，
 * 写三遍容易出现口径不一致。
 *
 * 2026-11-10 起海外证据有两个来源，必须分开看：
 *   · ESP（supplier.espwebsite.com）= 全 ASI 供应商目录总和 → 差异化的主依据
 *   · 4imprint = 单一分销商目录（最多 28 条）→ 只能说明"这一家切了多少"
 * 只报 4imprint 的条数会让人误判成"薄品类"，所以界面上 ESP 永远排前面。
 */

export interface MarketSnapshotLike {
  total: number
  matched?: number
  priceLow?: number | null
  priceHigh?: number | null
  demand?: {
    carriers: number
    reachable: number
  }
  esp?: {
    total: number
    matchedSample?: number
    sampleSize?: number
    priceLow?: number | null
    priceHigh?: number | null
    fallback?: boolean
    categories?: Array<{ name: string; count: number }>
  }
}

/** 千分位（12345 → 12,345） */
const comma = (n: number) => Math.round(n).toLocaleString('en-US')

/** "9/28 条同类"（4imprint 口径）；老评估只有总数时退回 "28 条" */
export function formatMarketHits(snap: { total: number; matched?: number }): string {
  const { total, matched } = snap
  if (typeof matched === 'number' && Number.isFinite(matched)) return `${matched}/${total} 条同类`
  return `${total} 条`
}

/** "ESP 全站 779 款同类"；没有 ESP 数据时返回空串 */
export function formatEspHits(snap: MarketSnapshotLike): string {
  const esp = snap.esp
  if (!esp || !(esp.total > 0)) return ''
  return `ESP 全站 ${comma(esp.total)} 款同类`
}

/** ESP 类目分布："NOTEBOOKS 80 · JOURNALS & DIARIES 39 · GIFT SETS 37" */
export function formatEspCategories(snap: MarketSnapshotLike, limit = 3): string {
  const cats = snap.esp?.categories ?? []
  return cats
    .slice(0, limit)
    .map((c) => `${c.name} ${comma(c.count)}`)
    .join(' · ')
}

/**
 * 一行紧凑写法，给列表/卡片用：
 *   有 ESP 数据 → "ESP 全站 779 款 · 分销商 2/3 家在卖 · 4imprint 3/28"
 *   没有 ESP（老评估）→ "4imprint 3/28 条同类"
 */
export function formatMarketSources(snap: MarketSnapshotLike): string {
  const esp = formatEspHits(snap)
  const four = formatMarketHits(snap)
  const parts: string[] = []
  if (esp) parts.push(esp)
  const demand = snap.demand
  if (demand && demand.reachable > 0) {
    parts.push(`分销商 ${demand.carriers}/${demand.reachable} 家在卖`)
  }
  if (parts.length) {
    if (snap.total > 0) parts.push(`4imprint ${four}`)
    return parts.join(' · ')
  }
  return four
}

/** 价格带的来源标签：ESP 样本价 / 4imprint 目录价 */
export function marketPriceSource(snap: MarketSnapshotLike): 'ESP' | '4imprint' {
  if (snap.esp && snap.esp.priceLow != null && (snap.priceLow == null || snap.total <= 0)) return 'ESP'
  return '4imprint'
}
