/**
 * 英文链接待审核库。
 *
 * 为什么单独一个库：批量生成的英文 listing 不能直接进产品库 ——
 * 标题/卖点/描述写歪了会直接上传到 ASI ESP，改起来比审一遍贵得多。
 * 所以流程是：生成 → 进这里（pending）→ 人工审核 → 通过才写 products。
 *
 * 这里不做任何新的业务判断：listing 由单品同一个 generateListing 产出，
 * 通过时用单品同一个 insertProduct 入库，评分/报价/印刷规则都不在这里重算。
 */

import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { insertProduct, sourceSchema, toSourceInfo } from './products'
import type { Evaluation, Listing, PriceRow, SourceInfo } from '../types'

export type ReviewStatus = 'pending' | 'approved' | 'rejected'

export interface ListingReviewRow {
  id: string
  batchJobId: string | null
  batchIdx: number | null
  title: string
  sourceUrl: string
  image: string
  score: number | null
  verdict: string | null
  source: SourceInfo
  evaluation: Evaluation | null
  listing: Listing
  priceGrid: PriceRow[]
  status: ReviewStatus
  productId: string | null
  reviewNote: string
  createdAt: string
  updatedAt: string
}

interface RawRow {
  id: string
  batch_job_id: string | null
  batch_idx: number | null
  title: string
  source_url: string
  image: string | null
  score: number | null
  verdict: string | null
  source: string
  evaluation: string | null
  listing: string
  price_grid: string
  status: string
  product_id: string | null
  review_note: string | null
  created_at: string
  updated_at: string
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

function toReview(r: RawRow): ListingReviewRow {
  return {
    id: r.id,
    batchJobId: r.batch_job_id,
    batchIdx: r.batch_idx,
    title: r.title,
    sourceUrl: r.source_url,
    image: r.image ?? '',
    score: r.score,
    verdict: r.verdict,
    source: toSourceInfo(sourceSchema.parse(parseJson(r.source, {}))),
    evaluation: parseJson<Evaluation | null>(r.evaluation, null),
    listing: parseJson<Listing>(r.listing, {} as Listing),
    priceGrid: parseJson<PriceRow[]>(r.price_grid, []),
    status: (r.status as ReviewStatus) ?? 'pending',
    productId: r.product_id,
    reviewNote: r.review_note ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 给批量和单品页用：新建一条待审核记录（同时把产品建好，状态 pending_review） */
export function createListingReview(input: {
  batchJobId?: string | null
  batchIdx?: number | null
  source: SourceInfo
  evaluation: Evaluation | null
  listing: Listing
  priceGrid: PriceRow[]
  draftId?: string | null
}): { id: string; productId: string } {
  const id = randomUUID()
  const now = new Date().toISOString()

  // 产品先建出来（status=pending_review）：这样审核页可以直接用单品那套
  // 「英文链接生成」页面打开、编辑、看 QC —— 和单个生成时完全一样。
  // 产品库列表默认不含 pending_review，所以没审过的不会混进正式产品。
  let productId = ''
  try {
    productId = insertProduct({
      source: input.source,
      evaluation: input.evaluation,
      listing: input.listing,
      similar: null,
      status: 'pending_review',
      draftId: input.draftId ?? null,
    })
  } catch (err) {
    throw new Error(`建立待审核产品失败：${err instanceof Error ? err.message : String(err)}`)
  }

  db.prepare(
    `INSERT INTO listing_reviews (id, batch_job_id, batch_idx, title, source_url, image, score, verdict,
      source, evaluation, listing, price_grid, status, product_id, review_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '', ?, ?)`
  ).run(
    id,
    input.batchJobId ?? null,
    input.batchIdx ?? null,
    (input.source.sourceTitle || input.listing?.title || '（未命名）').slice(0, 200),
    input.source.sourceUrl ?? '',
    (input.source.images ?? [])[0] ?? '',
    input.evaluation?.score ?? null,
    input.evaluation?.verdict ?? null,
    JSON.stringify(input.source),
    input.evaluation ? JSON.stringify(input.evaluation) : null,
    JSON.stringify(input.listing ?? {}),
    JSON.stringify(input.priceGrid ?? []),
    productId,
    now,
    now
  )
  return { id, productId }
}

/**
 * 资料改了 → 这条英文链接就过期了：删掉待审核记录。
 * 已通过的不动（产品已经进库，改资料应该去产品库改）。
 */
export function dropPendingReview(id: string): boolean {
  const r = db
    .prepare("SELECT status FROM listing_reviews WHERE id = ?")
    .get(id) as { status: string } | undefined
  if (!r || r.status === 'approved') return false
  db.prepare('DELETE FROM listing_reviews WHERE id = ?').run(id)
  return true
}

export function getListingReview(id: string): {
  id: string
  status: ReviewStatus
  productId: string | null
  reviewNote: string
} | null {
  const r = db.prepare('SELECT id, status, product_id, review_note FROM listing_reviews WHERE id = ?').get(id) as
    | { id: string; status: string; product_id: string | null; review_note: string | null }
    | undefined
  if (!r) return null
  return {
    id: r.id,
    status: (r.status as ReviewStatus) ?? 'pending',
    productId: r.product_id,
    reviewNote: r.review_note ?? '',
  }
}

export const listingReviewsRouter: Router = Router()

/**
 * 老记录补产品：拆出「先建 pending_review 产品」之前的待审核记录没有 product_id，
 * 服务启动时补一次，这样审核页也能用完整的英文链接编辑页打开它们。
 */
export function backfillPendingReviews(): number {
  try {
    const rows = db
      .prepare("SELECT * FROM listing_reviews WHERE product_id IS NULL AND status = 'pending'")
      .all() as unknown as RawRow[]
    let n = 0
    for (const row of rows) {
      const r = toReview(row)
      const pid = insertProduct({
        source: r.source,
        evaluation: r.evaluation,
        listing: r.listing,
        similar: null,
        status: 'pending_review',
        draftId: null,
      })
      db.prepare('UPDATE listing_reviews SET product_id=?, updated_at=? WHERE id=?').run(
        pid,
        new Date().toISOString(),
        r.id
      )
      n += 1
    }
    return n
  } catch {
    return 0
  }
}

backfillPendingReviews()

/** 列表（默认只看待审核）：轻量字段，不带 source/listing 大对象 */
listingReviewsRouter.get('/', (req: Request, res: Response) => {
  const status = String(req.query.status ?? 'pending')
  const q = String(req.query.q ?? '').trim()
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50))
  const offset = Math.max(0, Number(req.query.offset ?? 0) || 0)

  const where: string[] = []
  const args: unknown[] = []
  if (status !== 'all') {
    where.push('status = ?')
    args.push(status)
  }
  if (q) {
    where.push('(title LIKE ? OR source_url LIKE ?)')
    args.push(`%${q}%`, `%${q}%`)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const rows = db
    .prepare(
      `SELECT id, batch_job_id, batch_idx, title, source_url, image, score, verdict, status, product_id,
              review_note, created_at, updated_at
       FROM listing_reviews ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...(args as never[]), limit, offset) as unknown as Array<Record<string, unknown>>

  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM listing_reviews GROUP BY status')
    .all() as unknown as Array<{ status: string; n: number }>

  res.json({
    reviews: rows.map((r) => ({
      id: r.id,
      batchJobId: r.batch_job_id,
      batchIdx: r.batch_idx,
      title: r.title,
      sourceUrl: r.source_url,
      image: r.image,
      score: r.score,
      verdict: r.verdict,
      status: r.status,
      productId: r.product_id,
      reviewNote: r.review_note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    counts: {
      pending: counts.find((c) => c.status === 'pending')?.n ?? 0,
      approved: counts.find((c) => c.status === 'approved')?.n ?? 0,
      rejected: counts.find((c) => c.status === 'rejected')?.n ?? 0,
    },
    limit,
    offset,
  })
})

/** 详情：审核时看的全量内容（source + 评估 + listing + 报价表） */
listingReviewsRouter.get('/:id', (req: Request, res: Response) => {
  const row = db.prepare('SELECT * FROM listing_reviews WHERE id = ?').get(String(req.params.id)) as
    | unknown
    | RawRow
    | undefined
  if (!row) throw new AppError(404, '这条待审核记录不存在')
  res.json({ review: toReview(row as RawRow) })
})

/** 审核前可以直接改标题/卖点/描述/关键词（改完不入库，只是修正 listing） */
listingReviewsRouter.patch('/:id', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const row = db.prepare('SELECT * FROM listing_reviews WHERE id = ?').get(id) as unknown as RawRow | undefined
  if (!row) throw new AppError(404, '这条待审核记录不存在')
  if (row.status === 'approved') throw new AppError(409, '已经通过的不能再改，请到产品库里改')

  const body = z
    .object({
      listing: z
        .object({
          title: z.string().max(2000).optional(),
          summary: z.string().max(20000).optional(),
          description: z.string().max(60000).optional(),
          keywords: z.array(z.string().max(200)).max(200).optional(),
        })
        .optional(),
    })
    .parse(req.body ?? {})

  if (body.listing) {
    const merged = { ...parseJson<Record<string, unknown>>(row.listing, {}), ...body.listing }
    db.prepare('UPDATE listing_reviews SET listing=?, updated_at=? WHERE id=?').run(
      JSON.stringify(merged),
      new Date().toISOString(),
      id
    )
  }
  const fresh = db.prepare('SELECT * FROM listing_reviews WHERE id = ?').get(id) as unknown as RawRow
  res.json({ review: toReview(fresh) })
})

/** 通过 → 把已建好的产品从 pending_review 改成正式状态 */
listingReviewsRouter.post('/approve', (req: Request, res: Response) => {
  const body = z
    .object({ ids: z.array(z.string().min(1)).min(1).max(200) })
    .parse(req.body ?? {})

  const approved: string[] = []
  const failed: Array<{ id: string; error: string }> = []

  for (const id of body.ids) {
    try {
      const row = db.prepare('SELECT * FROM listing_reviews WHERE id = ?').get(id) as unknown as RawRow | undefined
      if (!row) {
        failed.push({ id, error: '记录不存在' })
        continue
      }
      const now = new Date().toISOString()
      let productId = row.product_id

      // 老记录（产品还没建）现在补建一条
      if (!productId) {
        const review = toReview(row)
        productId = insertProduct({
          source: review.source,
          evaluation: review.evaluation,
          listing: review.listing,
          similar: null,
          status: 'pending_review',
          draftId: null,
        })
      }

      db.prepare(
        "UPDATE products SET status='listed', review_state='approved', updated_at=? WHERE id=?"
      ).run(now, productId)
      db.prepare(
        "UPDATE listing_reviews SET status='approved', product_id=?, updated_at=? WHERE id=?"
      ).run(productId, now, id)
      approved.push(id)
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  res.json({ ok: true, approved, failed })
})

/** 驳回：产品留在库里但标成 archived（不进产品库、不删数据），附一句原因 */
listingReviewsRouter.post('/reject', (req: Request, res: Response) => {
  const body = z
    .object({
      ids: z.array(z.string().min(1)).min(1).max(200),
      note: z.string().max(500).optional(),
    })
    .parse(req.body ?? {})

  const now = new Date().toISOString()
  let n = 0
  for (const id of body.ids) {
    const row = db.prepare('SELECT product_id, status FROM listing_reviews WHERE id = ?').get(id) as
      | { product_id: string | null; status: string }
      | undefined
    if (!row || row.status === 'approved') continue
    db.prepare(
      "UPDATE listing_reviews SET status='rejected', review_note=?, updated_at=? WHERE id=?"
    ).run(body.note ?? '', now, id)
    if (row.product_id) {
      db.prepare(
        "UPDATE products SET status='archived', review_state='rejected', review_note=?, updated_at=? WHERE id=?"
      ).run(body.note ?? '', now, row.product_id)
    }
    n += 1
  }
  res.json({ ok: true, rejected: n })
})

/** 删除（真正删掉，不留档）：待审核产品一并清掉 */
listingReviewsRouter.post('/bulk-delete', (req: Request, res: Response) => {
  const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).parse(req.body ?? {})
  let n = 0
  for (const id of body.ids) {
    const row = db.prepare('SELECT product_id, status FROM listing_reviews WHERE id = ?').get(id) as
      | { product_id: string | null; status: string }
      | undefined
    if (row?.product_id && row.status !== 'approved') {
      db.prepare("DELETE FROM products WHERE id = ? AND status = 'pending_review'").run(row.product_id)
    }
    n += Number(db.prepare('DELETE FROM listing_reviews WHERE id = ?').run(id).changes ?? 0)
  }
  res.json({ ok: true, removed: n })
})

listingReviewsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const row = db.prepare('SELECT product_id, status FROM listing_reviews WHERE id = ?').get(id) as
    | { product_id: string | null; status: string }
    | undefined
  if (!row) throw new AppError(404, '记录不存在')
  if (row.product_id && row.status !== 'approved') {
    db.prepare("DELETE FROM products WHERE id = ? AND status = 'pending_review'").run(row.product_id)
  }
  db.prepare('DELETE FROM listing_reviews WHERE id = ?').run(id)
  res.json({ ok: true })
})
