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
  /** 价格明显异常（远低于同类中位数，多半是供应商数据错误） */
  suspicious?: boolean
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
  /*
   * 价格异常值过滤：ESP 上确实存在供应商填错价的情况（三件套礼盒挂 $0.86）。
   * 拿这种"同款但价格离谱"的样本算比价，结论会比没有比价更糟。
   * 参考基准用标题同类样本的中位数（宽口径，只挡掉数量级不对的），阈值取 30%。
   */
  const refMedian = market.esp?.priceSameForm?.median ?? market.esp?.price?.median ?? null
  const items: CheckedItem[] = candidates.map((c) => {
    const v = byIndex.get(c.index)
    const same = Boolean(v?.same)
    const bad = Boolean(same && refMedian && c.priceMin < refMedian * 0.3)
    return {
      title: c.title,
      priceMin: c.priceMin,
      url: c.url,
      source: c.source,
      ...(c.image ? { image: c.image } : {}),
      same,
      confidence: v?.confidence ?? 0,
      ...(v?.reason ? { reason: v.reason } : {}),
      ...(bad ? { suspicious: true } : {}),
    }
  })
  // 低把握的"同款"不算：宁可样本少，也不要拿错样本算价格
  const confirmed = items.filter((i) => i.same && i.confidence >= 0.6)
  const usable = confirmed.filter((i) => !i.suspicious)
  const suspiciousCount = confirmed.length - usable.length
  /*
   * 少于 3 条就**不给价格带**：1-2 条样本很容易撞上极端值（实测 2 条都撞上了供应商错价），
   * 给出去的"精确区间"会直接被当成报价依据，比不给更危险。
   */
  const price = usable.length >= 3 ? priceBandOf(usable.map((i) => i.priceMin)) : null

  const noteParts: string[] = []
  if (!confirmed.length) {
    noteParts.push(`识图比对 ${items.length} 条候选，没有一条是真同款：本次没有可比价格，别拿标题同类的价格带下结论`)
  } else if (suspiciousCount) {
    noteParts.push(`识图确认 ${confirmed.length} 条同款，其中 ${suspiciousCount} 条价格明显异常（远低于同类中位 ${refMedian}）已剔除`)
  }
  if (confirmed.length && !price) {
    noteParts.push(`可用样本只有 ${usable.length} 条（<3），样本太少不给价格结论`)
  } else if (price && usable.length < 5) {
    noteParts.push(`可用样本 ${usable.length} 条，价格带仅作参考`)
  } else if (price) {
    noteParts.push(`按 ${usable.length} 条识图同款算价格带`)
  }

  return { checked: items.length, sameCount: usable.length, price, items, note: noteParts.join('；') }
}
