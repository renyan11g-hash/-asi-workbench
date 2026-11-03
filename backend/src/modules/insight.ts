import { Router, Request, Response } from 'express'
import { db } from '../db'

/**
 * 只读复盘接口（/api/insight/*）
 *
 * 用途：把「审核队列里点过的通过/否决」变成可以统计、可以反哺选品的数据。
 * 访问方式：GET /api/insight/review?token=<SYNC_TOKEN>
 *   —— 外部核对工具只能发 GET、不能带自定义头，所以这里允许 token 走 query，
 *      并且只在 /api/insight 前缀下生效（见 middleware/auth.ts）。
 * 本路由全部只读，不修改任何数据。
 */
export const insightRouter: Router = Router()

interface ProductRow {
  id: string
  source_title: string | null
  source_url: string | null
  price_cny: number | null
  category: string | null
  origin: string | null
  review_state: string | null
  reject_reasons: string | null
  review_note: string | null
  reviewed_at: string | null
  selection_reason: string | null
  evaluation: string | null
  trashed_at: string | null
}

const parseReasons = (raw: string | null): string[] => {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.map((x) => String(x)) : []
  } catch {
    return []
  }
}

/** selectionReason 里带了命中词：「搜索词「定制杯垫」命中；…」 */
const keywordOf = (reason: string | null): string => {
  const m = (reason || '').match(/搜索词「([^」]{1,20})」/)
  return m ? m[1] : ''
}

const categoryOf = (r: ProductRow): string => {
  if (r.category) return r.category
  try {
    const e = JSON.parse(r.evaluation || '{}') as { asiCategories?: unknown }
    const first = Array.isArray(e.asiCategories) ? e.asiCategories[0] : undefined
    return typeof first === 'string' ? first : ''
  } catch {
    return ''
  }
}

const bump = (m: Record<string, number>, key: string, n = 1) => {
  if (!key) return
  m[key] = (m[key] ?? 0) + n
}

const topEntries = (m: Record<string, number>, limit = 30) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))

/** 审核结果总览 + 否决原因分布 */
insightRouter.get('/review', async (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM products WHERE trashed_at IS NULL').all() as unknown as ProductRow[]

  const byState: Record<string, number> = { pending: 0, approved: 0, parked: 0, rejected: 0 }
  const reasonCount: Record<string, number> = {}
  const rejectByCategory: Record<string, number> = {}
  const rejectByKeyword: Record<string, number> = {}
  const approvedByCategory: Record<string, number> = {}
  // 关键词的否决率：命中的词一共导入了多少、其中多少被否
  const keywordTotal: Record<string, number> = {}
  const keywordRejected: Record<string, number> = {}
  const recentRejected: Array<Record<string, unknown>> = []

  for (const r of rows) {
    const state = r.review_state || 'pending'
    byState[state] = (byState[state] ?? 0) + 1

    const kw = keywordOf(r.selection_reason)
    if (kw) bump(keywordTotal, kw)

    const cat = categoryOf(r)
    const reasons = parseReasons(r.reject_reasons)

    if (state === 'rejected') {
      reasons.forEach((x) => bump(reasonCount, x))
      if (cat) bump(rejectByCategory, cat)
      if (kw) {
        bump(rejectByKeyword, kw)
        bump(keywordRejected, kw)
      }
      if (recentRejected.length < 60) {
        recentRejected.push({
          title: r.source_title ?? '',
          keywords: kw,
          category: cat,
          priceCny: r.price_cny,
          reasons,
          note: r.review_note ?? '',
          origin: r.origin ?? 'manual',
          sourceUrl: r.source_url ?? '',
          reviewedAt: r.reviewed_at ?? '',
        })
      }
    } else if (state === 'approved' && cat) {
      bump(approvedByCategory, cat)
    }
  }

  // 关键词否决率（至少出现 2 次才算，避免单条样本噪声）
  const keywordRejectRate = Object.keys(keywordTotal)
    .filter((k) => (keywordTotal[k] ?? 0) >= 2)
    .map((k) => ({
      keyword: k,
      total: keywordTotal[k] ?? 0,
      rejected: keywordRejected[k] ?? 0,
      rejectRate: Number((((keywordRejected[k] ?? 0) / (keywordTotal[k] ?? 1)) * 100).toFixed(0)),
    }))
    .sort((a, b) => b.rejectRate - a.rejectRate || b.total - a.total)

  recentRejected.sort((a, b) => String(b.reviewedAt).localeCompare(String(a.reviewedAt)))

  res.json({
    generatedAt: new Date().toISOString(),
    total: rows.length,
    byState,
    reasonCount,
    topReasons: topEntries(reasonCount),
    rejectByCategory: topEntries(rejectByCategory),
    approvedByCategory: topEntries(approvedByCategory),
    rejectByKeyword: topEntries(rejectByKeyword),
    keywordRejectRate,
    recentRejected,
  })
})

/**
 * 给每日选品脚本用：把「历史否决率过高」的搜索词列出来，让它下次别再搜这类。
 *
 * 规则：某个搜索词导入过的候选 ≥2 条，且否决率 ≥60% → 进黑名单。
 * 样本太小不判（避免一条否决就把词封了）。
 */
insightRouter.get('/keyword-feedback', async (_req: Request, res: Response) => {
  const rows = db
    .prepare(
      `SELECT selection_reason, review_state FROM products
       WHERE trashed_at IS NULL AND selection_reason IS NOT NULL AND selection_reason <> ''`
    )
    .all() as unknown as Array<{ selection_reason: string | null; review_state: string | null }>

  const total: Record<string, number> = {}
  const rejected: Record<string, number> = {}

  for (const r of rows) {
    const kw = keywordOf(r.selection_reason)
    if (!kw) continue
    bump(total, kw)
    if ((r.review_state || 'pending') === 'rejected') bump(rejected, kw)
  }

  const stats = Object.keys(total)
    .map((keyword) => {
      const t = total[keyword] ?? 0
      const x = rejected[keyword] ?? 0
      return { keyword, total: t, rejected: x, rejectRate: Number(((x / t) * 100).toFixed(0)) }
    })
    .sort((a, b) => b.rejectRate - a.rejectRate || b.total - a.total)

  const blacklist = stats.filter((s) => s.total >= 2 && s.rejectRate >= 60).map((s) => s.keyword)

  res.json({ generatedAt: new Date().toISOString(), blacklist, stats })
})
