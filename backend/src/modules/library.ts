/**
 * 预产品库 / RPA 档案库 / 评估库 的接口（2026-11-07 流程合并）。
 *
 * 一条产品的完整路径都在这几个接口里串起来：
 *   资料库导入 → 流水线（自动建档）→ 批量评估 → 评估库等人工审核
 *   → 审核通过自动排队生成英文链接 → listing 待审核 → 预产品库（发 GLS 号）
 *   → 需要重新赋号的，从预产品库移进 RPA 档案库。
 */

import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import {
  archiveToRpa,
  enterPreLibrary,
  getDraftEvaluation,
  listEvaluations,
  listPreProducts,
  listRpaArchive,
  previewGlSNumbering,
} from '../services/library'
import { createJob, startJob } from '../services/production-jobs'

export const libraryRouter: Router = Router()

/** 预产品库列表 */
libraryRouter.get('/pre-products', (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim().toLowerCase()
  let rows = listPreProducts()
  if (q) {
    rows = rows.filter(
      (r) =>
        r.code.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q) ||
        r.sourceUrl.toLowerCase().includes(q)
    )
  }
  res.json({ rows, total: rows.length })
})

/** RPA 档案库列表 */
libraryRouter.get('/rpa', (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim().toLowerCase()
  let rows = listRpaArchive()
  if (q) {
    rows = rows.filter(
      (r) => r.code.toLowerCase().includes(q) || r.title.toLowerCase().includes(q) || r.sourceUrl.toLowerCase().includes(q)
    )
  }
  res.json({ rows, total: rows.length })
})

/** 从预产品库移进 RPA 档案库：人工给新编号（覆盖旧编号） */
libraryRouter.post('/rpa/archive', (req: Request, res: Response) => {
  const body = z
    .object({
      entries: z
        .array(z.object({ productId: z.string().min(1), code: z.string().min(1).max(40) }))
        .min(1)
        .max(50),
    })
    .parse(req.body ?? {})
  const result = archiveToRpa(body.entries)
  res.json({ ok: true, ...result })
})

/** 评估库列表：按「评估审核结果」和关键词筛选 */
libraryRouter.get('/evaluations', (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim().toLowerCase()
  const status = String(req.query.status ?? 'all')

  let rows = listEvaluations()
  const counts = {
    all: rows.length,
    pending: rows.filter((r) => r.evalReview === 'pending').length,
    approved: rows.filter((r) => r.evalReview === 'approved').length,
    rejected: rows.filter((r) => r.evalReview === 'rejected').length,
    none: rows.filter((r) => !r.evalReview && !r.orphan).length,
    /** 改版前留在评估库、还没关联产品的老草稿 */
    orphan: rows.filter((r) => r.orphan).length,
  }
  if (status === 'pending') rows = rows.filter((r) => r.evalReview === 'pending')
  else if (status === 'approved') rows = rows.filter((r) => r.evalReview === 'approved')
  else if (status === 'rejected') rows = rows.filter((r) => r.evalReview === 'rejected')
  else if (status === 'none') rows = rows.filter((r) => !r.evalReview && !r.orphan)
  else if (status === 'orphan') rows = rows.filter((r) => r.orphan)

  if (q) {
    rows = rows.filter(
      (r) =>
        r.code.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q) ||
        r.evalSummary.toLowerCase().includes(q) ||
        r.sourceUrl.toLowerCase().includes(q)
    )
  }
  res.json({ rows, counts, total: rows.length })
})

/**
 * 老草稿的评估详情（那条还没进产品档案时，点「详情」走这里）。
 * 返回完整的评估对象，前端按和产品评估一样的版式渲染。
 */
libraryRouter.get('/evaluations/:draftId', (req: Request, res: Response) => {
  const draft = getDraftEvaluation(String(req.params.draftId))
  if (!draft) throw new AppError(404, '这条评估记录不存在')
  res.json({
    id: draft.id,
    title: draft.title,
    source: (draft.content as { source?: unknown }).source ?? null,
    evaluation: (draft.content as { evaluation?: unknown }).evaluation ?? null,
    priceGrid: (draft.content as { priceGrid?: unknown }).priceGrid ?? null,
  })
})

/**
 * 批量评估：一条产品一次 AI 评估 + 一次看图找同款，跑完自动存进评估库并标「待人工审核」。
 * 用后台任务跑（每个约 1~2 分钟），可以暂停/继续/取消，失败一条不影响其他条。
 */
libraryRouter.post('/evaluate', (req: Request, res: Response) => {
  const body = z
    .object({
      productIds: z.array(z.string().min(1)).min(1).max(20),
      clientKey: z.string().max(80).optional(),
    })
    .parse(req.body ?? {})
  const result = createJob({
    kind: 'evaluate',
    productIds: body.productIds,
    clientKey: body.clientKey,
    note: '批量评估',
  })
  const job = result.deduped ? result.job : (startJob(result.job.id) ?? result.job)
  res.status(result.deduped ? 200 : 201).json({ job, deduped: result.deduped, skipped: result.skipped })
})

/**
 * 评估人工审核：
 *   通过 → 自动排队生成英文 Listing（走单品同一套 generateListing，结果进 listing 待审核）
 *   不通过 → 标成待定（留在评估库，可筛选出来重新评估）
 */
libraryRouter.post('/eval-review', (req: Request, res: Response) => {
  const body = z
    .object({
      ids: z.array(z.string().min(1)).min(1).max(50),
      decision: z.enum(['approve', 'reject']),
      note: z.string().max(500).optional(),
    })
    .parse(req.body ?? {})
  const now = new Date().toISOString()
  const changed: string[] = []
  for (const id of body.ids) {
    const row = db.prepare('SELECT id, evaluation FROM products WHERE id = ?').get(id) as
      | { id: string; evaluation: string | null }
      | undefined
    if (!row) continue
    if (!row.evaluation) continue
    db.prepare('UPDATE products SET eval_review=?, eval_reviewed_at=?, review_note=?, updated_at=? WHERE id=?').run(
      body.decision === 'approve' ? 'approved' : 'rejected',
      now,
      body.decision === 'reject' ? (body.note ?? '') : '',
      now,
      id
    )
    changed.push(id)
  }

  let job: unknown = null
  if (body.decision === 'approve' && changed.length) {
    // 通过即自动进入下一进程：生成英文链接（后台排队，和单品生成同一个函数）
    const created = createJob({
      kind: 'listing',
      productIds: changed,
      clientKey: `eval-approved-${Date.now()}`,
      note: '评估通过自动生成英文链接',
    })
    job = startJob(created.job.id) ?? created.job
  }
  res.json({ ok: true, changed: changed.length, job })
})

/** 把产品手动放进预产品库（正常路径是 listing 审核通过自动进，这里给补录/纠错用） */
libraryRouter.post('/to-pre', (req: Request, res: Response) => {
  const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(50) }).parse(req.body ?? {})
  const moved: Array<{ id: string; code: string; assigned: boolean }> = []
  for (const id of body.ids) {
    const r = enterPreLibrary(id)
    if (r) moved.push({ id, ...r })
  }
  res.json({ ok: true, moved })
})

/** 迁移预览：75 个已上架产品会变成哪些 GLS 号（只读，不动数据） */
libraryRouter.get('/numbering-preview', (_req: Request, res: Response) => {
  const rows = previewGlSNumbering()
  res.json({ rows, total: rows.length })
})
