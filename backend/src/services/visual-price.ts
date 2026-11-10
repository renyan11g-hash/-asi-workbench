/**
 * 识图比价（把"候选图 + 价格"过一遍视觉模型，只留真同款）。
 *
 * 标题匹配能看"品类有多挤"，但看不了"这个货是不是同一个东西"。
 * 三件套礼盒按标题能匹配到单本笔记本，价格自然对不上——所以价格结论只认识图。
 *
 * 这一层只做三件事：挑候选 → 交给视觉模型 → 汇总"识图同款"的价格带。
 * 任何一步失败都返回"没有可比样本"，而不是给一个看起来精确的假区间。
 */

import type { MarketSnapshot } from './market-probe'
import type { Settings } from '../types'
import { priceBandOf } from './market-text'
import { matchSameProductByImage, type VisualCandidate } from './visual-match'

export interface CheckedItem {
  title: string
  priceMin: number
  url: string
  source: string
  image?: string
  same: boolean
  confidence: number
  reason?: string
}

export interface VisualPriceCheck {
  /** 送去识图的候选数量 */
  checked: number
  /** 识图确认的同款数量 */
  sameCount: number
  /** 识图同款的价格带（只有这个能拿来比价） */
  price: { min: number; p25: number; median: number; p75: number; max: number } | null
  items: CheckedItem[]
  /** 一句中文说明（界面/提示词共用） */
  note: string
}

/** 候选挑法：ESP 取最便宜的若干条 + 每家分销商取最便宜的两条（贵的先不看，比价看下限更狠） */
function pickCandidates(market: MarketSnapshot, limit = 8): VisualCandidate[] {
  const out: VisualCandidate[] = []
  const esp = market.esp?.items ?? []
  for (const it of esp.slice(0, 6)) {
    if (!it.image) continue
    out.push({
      index: out.length,
      title: it.title,
      image: it.image,
      priceMin: it.priceMin,
      source: 'ESP',
      url: it.url,
    })
  }
  for (const s of market.demand?.sources ?? []) {
    for (const it of (s.items ?? []).slice(0, 2)) {
      if (!it.image) continue
      if (out.length >= limit) break
      out.push({
        index: out.length,
        title: it.title,
        image: it.image,
        priceMin: it.priceMin,
        source: s.name,
        url: it.url,
      })
    }
  }
  return out.slice(0, limit)
}

export async function buildVisualPriceCheck(
  settings: Settings,
  ourImages: string[],
  ourLabel: string,
  market: MarketSnapshot | null
): Promise<VisualPriceCheck | null> {
  if (!market) return null
  const candidates = pickCandidates(market)
  if (!candidates.length) {
    return {
      checked: 0,
      sameCount: 0,
      price: null,
      items: [],
      note: '竞品卡片里没有可用图片，无法识图比价',
    }
  }
  if (!ourImages.length) {
    return {
      checked: candidates.length,
      sameCount: 0,
      price: null,
      items: [],
      note: '没有我司产品图，无法识图比价（标题匹配的价格带只能看类目，不能当比价依据）',
    }
  }

  const verdicts = await matchSameProductByImage(settings, ourImages, candidates, ourLabel)
  if (!verdicts) {
    return {
      checked: candidates.length,
      sameCount: 0,
      price: null,
      items: [],
      note: '视觉模型这次没给出结果（可能不支持看图），本次不做识图比价',
    }
  }

  const byIndex = new Map(verdicts.map((v) => [v.index, v]))
  const items: CheckedItem[] = candidates.map((c) => {
    const v = byIndex.get(c.index)
    return {
      title: c.title,
      priceMin: c.priceMin,
      url: c.url,
      source: c.source,
      ...(c.image ? { image: c.image } : {}),
      same: Boolean(v?.same),
      confidence: v?.confidence ?? 0,
      ...(v?.reason ? { reason: v.reason } : {}),
    }
  })
  // 低把握的"同款"不算：宁可样本少，也不要拿错样本算价格
  const confirmed = items.filter((i) => i.same && i.confidence >= 0.6)
  const price = priceBandOf(confirmed.map((i) => i.priceMin))

  const note =
    confirmed.length === 0
      ? `识图比对 ${items.length} 条候选，没有一条是真同款：本次没有可比价格，别拿标题同类的价格带下结论`
      : confirmed.length < 3
        ? `识图只确认了 ${confirmed.length} 条同款（样本偏少），价格带仅供参考`
        : `识图确认 ${confirmed.length} 条真同款，价格带按这 ${confirmed.length} 条算`

  return { checked: items.length, sameCount: confirmed.length, price, items, note }
}
