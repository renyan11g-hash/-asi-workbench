/**
 * 批量生产中心 API（批量生产系统 V1 · 第二/四/五阶段）。
 *
 * 只做「排队 + 进度 + 控制」，业务规则全部复用单品流程：
 *   Listing 生成 → services/workbench.generateListing（和单品页同一个函数）
 *   质量检查   → services/listing-qc
 *   结构化资料 → services/product-specs.extractSpecs
 * 这里不重写任何提示词、评分口径或报价算法。
 */

import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AppError } from '../middleware/errorHandler'
import { listAiCalls, summarizeAiCalls } from '../services/ai-log'
import { MAX_PRODUCTION_ITEMS, SUGGESTED_PRODUCTION_ITEMS } from '../services/production-jobs'
import {
  cancelJob,
  createJob,
  getJob,
  listJobs,
  pauseJob,
  recoverInterruptedProductionJobs,
  resumeJob,
  retryFailed,
  retryItem,
  startJob,
} from '../services/production-jobs'
import { listProductCards } from './product-specs'
import { SPEC_FIELDS } from '../services/product-specs'

export const productionRouter: Router = Router()

/**
 * 服务启动（每次发版都会重启）时收尾：把上次跑到一半的任务标成「已中断」，
 * 跑到一半的条目放回排队。用户刷新页面能看到，点「继续」接着跑。
 */
recoverInterruptedProductionJobs()

/** 可选产品列表：批量生产中心左半边那张表（编号/名称/完整度/类别/当前状态） */
productionRouter.get('/candidates', (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim().toLowerCase()
  const category = String(req.query.category ?? '').trim()
  const only = String(req.query.only ?? 'all')

  let cards = listProductCards()
  const categories = Array.from(new Set(cards.map((c) => c.category).filter(Boolean))).sort()

  if (q) {
    cards = cards.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
    )
  }
  if (category) cards = cards.filter((c) => c.category === category)
  if (only === 'specs-ready') cards = cards.filter((c) => c.specs.filled > 0)
  else if (only === 'specs-missing') cards = cards.filter((c) => c.specs.filled < c.specs.total)
  else if (only === 'has-listing') cards = cards.filter((c) => c.hasListing)
  else if (only === 'no-listing') cards = cards.filter((c) => !c.hasListing)

  res.json({
    cards,
    categories,
    counts: {
      all: cards.length,
      specsReady: cards.filter((c) => c.specs.filled > 0).length,
      specsMissing: cards.filter((c) => c.specs.filled < c.specs.total).length,
      hasListing: cards.filter((c) => c.hasListing).length,
    },
    limits: { max: MAX_PRODUCTION_ITEMS, suggested: SUGGESTED_PRODUCTION_ITEMS },
    fields: SPEC_FIELDS,
  })
})

const createSchema = z.object({
  kind: z.enum(['listing', 'spec']).default('listing'),
  productIds: z.array(z.string().min(1)).min(1).max(MAX_PRODUCTION_ITEMS),
  note: z.string().max(300).optional(),
  /** 幂等键：前端每次点击生成一个；重试用同一个 */
  clientKey: z.string().max(80).optional(),
  options: z.record(z.unknown()).optional(),
})

/** 建任务并立刻开跑（后台顺序执行，立即返回，不等 AI） */
productionRouter.post('/jobs', (req: Request, res: Response) => {
  const body = createSchema.parse(req.body ?? {})
  const result = createJob({
    kind: body.kind,
    productIds: body.productIds,
    note: body.note,
    clientKey: body.clientKey,
    options: body.options as Record<string, unknown> | undefined,
  })
  const job = result.deduped ? result.job : (startJob(result.job.id) ?? result.job)
  res.status(result.deduped ? 200 : 201).json({
    job,
    deduped: result.deduped,
    skipped: result.skipped,
  })
})

productionRouter.get('/jobs', (req: Request, res: Response) => {
  const limit = Number(req.query.limit ?? 20)
  res.json({ jobs: listJobs(limit) })
})

productionRouter.get('/jobs/:id', (req: Request, res: Response) => {
  const job = getJob(String(req.params.id))
  if (!job) throw new AppError(404, '任务不存在')
  const done = job.items.filter((i) => i.status === 'success').length
  const failed = job.items.filter((i) => i.status === 'failed').length
  const cancelled = job.items.filter((i) => i.status === 'cancelled').length
  const runningItem = job.items.find((i) => i.status === 'running')
  res.json({
    job,
    progress: {
      total: job.items.length,
      done,
      failed,
      cancelled,
      pending: job.items.length - done - failed - cancelled,
      percent: job.items.length ? Math.round(((done + failed + cancelled) / job.items.length) * 100) : 0,
      current: runningItem ? runningItem.code || runningItem.title : '',
    },
  })
})

productionRouter.post('/jobs/:id/run', (req: Request, res: Response) => {
  const job = resumeJob(String(req.params.id))
  if (!job) throw new AppError(404, '任务不存在')
  res.json({ job })
})

productionRouter.post('/jobs/:id/pause', (req: Request, res: Response) => {
  const job = pauseJob(String(req.params.id))
  if (!job) throw new AppError(404, '任务不存在')
  res.json({ job })
})

productionRouter.post('/jobs/:id/cancel', (req: Request, res: Response) => {
  const job = cancelJob(String(req.params.id))
  if (!job) throw new AppError(404, '任务不存在')
  res.json({ job })
})

productionRouter.post('/jobs/:id/retry-failed', (req: Request, res: Response) => {
  const job = retryFailed(String(req.params.id))
  if (!job) throw new AppError(404, '任务不存在')
  res.json({ job })
})

productionRouter.post('/jobs/:id/items/:idx/retry', (req: Request, res: Response) => {
  const job = retryItem(String(req.params.id), Number(req.params.idx))
  if (!job) throw new AppError(404, '任务不存在')
  res.json({ job })
})

/** 模型调用台账：批量生产中心底部「这次花了多少」 */
productionRouter.get('/ai-logs', (req: Request, res: Response) => {
  const limit = Number(req.query.limit ?? 100)
  const task = req.query.task ? String(req.query.task) : undefined
  res.json({
    logs: listAiCalls(limit, task),
    summary: summarizeAiCalls(Number(req.query.hours ?? 24)),
  })
})
