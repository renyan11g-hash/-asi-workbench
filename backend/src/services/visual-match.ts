/**
 * 识图比价：用视觉模型判断"竞品图和我们自己的产品图是不是同一种东西"。
 *
 * 为什么必须这么做：标题只能说明"这个品类"，说明不了"这个货"。
 * 实测反例——竹木三件套礼盒，按标题判"同形态（套装）"挑出来的 12 条链接，
 * 点进去是单本笔记本、两件套、甚至完全不同的东西。用这些样本算出来的"同形态价格带"
 * 看起来更精确，其实是假的精确，比不做还危险。
 *
 * 所以价格对比的口径改成：只有**识图确认的同款**才能进价格带；标题匹配继续保留，
 * 但只用来观察类目拥挤度（"这个品类有多少人在做"），不参与价格结论。
 *
 * 调用成本控制：每次评估最多 2 批、每批最多 4 个候选图，我们自己最多送 2 张图。
 * 失败（模型不支持视觉 / 图抓不到）一律返回 null，让上层降级成"缺识图样本"，绝不编结论。
 */

import { callChatJson } from './ai'
import type { Settings } from '../types'

export interface VisualCandidate {
  /** 候选在下游列表里的下标，用来回填结果 */
  index: number
  title: string
  image: string
  priceMin: number
  source: string
  url: string
}

export interface VisualVerdict {
  index: number
  /** 是否同一款产品（件数/结构/材质/外形都要对得上） */
  same: boolean
  /** 0-1，模型自评把握 */
  confidence: number
  /** 一句话理由（中文，给界面看） */
  reason?: string
}

const SYSTEM = `You are a product-matching analyst for the US promotional products industry (ASI).
You are given OUR product photos first, then candidate product photos from supplier/distributor catalogues.

Decide for EACH candidate whether it is CLOSE ENOUGH TO COMPARE PRICES with ours.
- "Same" means: the same kind of product for the same purpose, with roughly the same form factor and components.
  Minor differences are FINE and still count as same: slightly different piece count, a different accessory,
  different sizes/capacities, different material finish, a different colour or logo.
- "Not same" means: a different product category or a clearly different form (e.g. a single notebook vs a gift set,
  a mug vs a notebook, a bag vs a stationery set). The price of such an item says nothing about ours.
Use judgement like a buyer would: if a distributor could reasonably offer it as an alternative to ours, it is same.

Respond with STRICT JSON only:
{"results":[{"n":1,"same":true,"confidence":0.0-1.0,"reason":"<one short Chinese sentence>"}]}
"n" is the candidate number printed in the prompt (1-based). Judge every candidate.`

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * 识图比对。ourImages 为空 / 没有 AI Key / 模型不支持视觉 → 返回 null（上层写"缺识图样本"）。
 */
export async function matchSameProductByImage(
  settings: Settings,
  ourImages: string[],
  candidates: VisualCandidate[],
  ourLabel: string,
  opts: { maxBatches?: number; batchSize?: number } = {}
): Promise<VisualVerdict[] | null> {
  const ours = ourImages.map((s) => s.trim()).filter(Boolean).slice(0, 2)
  const list = candidates.filter((c) => /^https?:\/\//i.test(c.image) || c.image.startsWith('data:image/'))
  if (!ours.length || !list.length || !settings.aiApiKey?.trim()) return null

  // 视觉调用很慢（单批 6 张图约 40-60 秒），一批就够：宁可样本少，也不要超过代理超时
  const batchSize = opts.batchSize ?? 5
  const maxBatches = opts.maxBatches ?? 1
  const batches = chunk(list, batchSize).slice(0, maxBatches)
  const out: VisualVerdict[] = []

  /*
   * 各批并行：视觉调用每批要 10-20 秒，串行 3 批会把整个评估拖到 100 秒以上
   * （Render 前置代理对单请求有时限）。并行后总耗时≈最慢的那一批。
   */
  const results = await Promise.all(
    batches.map(async (batch) => {
      const lines = batch
        .map((c, i) => `Candidate ${i + 1}: "${c.title}" — $${c.priceMin} (${c.source})`)
        .join('\n')
      const user = `OUR PRODUCT: ${ourLabel}

The first ${ours.length} image(s) are OURS. Then come ${batch.length} candidate photo(s), in order:
${lines}

Compare each candidate photo against OUR photos and answer same / not-same.`
      try {
        const data = await callChatJson<{ results?: Array<Record<string, unknown>> }>(
          settings,
          SYSTEM,
          user,
          0,
          [...ours, ...batch.map((c) => c.image)]
        )
        const rows = Array.isArray(data?.results) ? data.results : []
        const verdicts: VisualVerdict[] = []
        for (const r of rows) {
          const n = Number(r.n ?? r.index ?? 0)
          const cand = batch[n - 1]
          if (!cand) continue
          verdicts.push({
            index: cand.index,
            same: r.same === true || String(r.same).toLowerCase() === 'true',
            confidence: Math.max(0, Math.min(1, Number(r.confidence ?? 0.5))),
            ...(typeof r.reason === 'string' && r.reason.trim()
              ? { reason: r.reason.trim().slice(0, 120) }
              : {}),
          })
        }
        return verdicts
      } catch {
        // 这一批失败不影响其它批
        return [] as VisualVerdict[]
      }
    })
  )
  for (const r of results) out.push(...r)

  return out.length ? out : null
}
