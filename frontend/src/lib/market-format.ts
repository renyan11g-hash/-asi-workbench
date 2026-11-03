/**
 * 海外同款证据的统一展示格式。
 *
 * 为什么要单独抽出来：`matched` 是后加的字段，老评估里没有；
 * 而且三个页面（选品预估 / 产品信息预填 / 产品库）都要显示同一句话，
 * 写三遍容易出现"28 条"和"9/28 条同类"混着显示的情况。
 */

export interface MarketSnapshotLike {
  total: number
  matched?: number
}

/** "9/28 条同类"（新评估）；老评估只有总数时退回 "28 条" */
export function formatMarketHits(snap: MarketSnapshotLike): string {
  const { total, matched } = snap
  if (typeof matched === 'number' && Number.isFinite(matched)) return `${matched}/${total} 条同类`
  return `${total} 条`
}
