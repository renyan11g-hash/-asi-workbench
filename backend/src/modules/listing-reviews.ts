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
import { insertProduct, applyListingToExistingProduct, sourceSchema, toSourceInfo, findProduct } from './products'
import type { Evaluation, Listing, PriceRow, SourceInfo } from '../types'
import type { ListingQcReport } from '../services/listing-qc'
import { mergeAiQc, runListingQc } from '../services/listing-qc'
import { runAiListingQc } from '../services/listing-qc-ai'
import { SPEC_FIELDS, getSpecRecord, isKnown } from '../services/product-specs'
import { regenerateListingFields } from '../services/workbench'
import { enterPreLibrary } from '../services/library'
import { loadSettings } from './settings'

export type ReviewStatus = 'pending' | 'approved' | 'rejected'

/**
 * 两种写入模式：
 *  inline  旧流程 —— 生成时就把 listing 写进产品档案（状态 pending_review），审核只改状态
 *  staged  批量生产 —— 生成结果只存在这张审核记录里，**审核通过才写回产品**，
 *          所以批量重新生成不会覆盖产品库里现有的 Listing（用户明确要求的硬约束）
 */
export type ReviewMode = 'inline' | 'staged'

export interface ListingReviewRow {
  id: string
  batchJobId: string | null
  batchIdx: number | null
  /** 批量生产任务 id / 条目序号（staged 模式才有） */
  jobId: string | null
  itemIdx: number | null
  mode: ReviewMode
  /** 质量检查报告（程序规则 + 可选 AI 复检） */
  qc: ListingQcReport | null
  title: string
  sourceUrl: string
  image: string
  score: number | null
  verdict: string | null
  source: SourceInfo
  evaluation: Evaluation | null
  listing: Listing
  /** 生成草稿时产品上原有的 listing（通过后会被替换，留一份可回溯） */
  prevListing: Listing | null
  priceGrid: PriceRow[]
  status: ReviewStatus
  productId: string | null
  reviewNote: string
  editedAt: string | null
  createdAt: string
  updatedAt: string
}

interface RawRow {
  id: string
  batch_job_id: string | null
  batch_idx: number | null
  job_id?: string | null
  item_idx?: number | null
  mode?: string | null
  qc?: string | null
  title: string
  source_url: string
  image: string | null
  score: number | null
  verdict: string | null
  source: string
  evaluation: string | null
  listing: string
  prev_listing?: string | null
  price_grid: string
  status: string
  product_id: string | null
  review_note: string | null
  edited_at?: string | null
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
    jobId: r.job_id ?? null,
    itemIdx: r.item_idx ?? null,
    mode: (r.mode as ReviewMode) ?? 'inline',
    qc: parseJson<ListingQcReport | null>(r.qc ?? null, null),
    title: r.title,
    sourceUrl: r.source_url,
    image: r.image ?? '',
    score: r.score,
    verdict: r.verdict,
    source: toSourceInfo(sourceSchema.parse(parseJson(r.source, {}))),
    evaluation: parseJson<Evaluation | null>(r.evaluation, null),
    listing: parseJson<Listing>(r.listing, {} as Listing),
    prevListing: parseJson<Listing | null>(r.prev_listing ?? null, null),
    priceGrid: parseJson<PriceRow[]>(r.price_grid, []),
    status: (r.status as ReviewStatus) ?? 'pending',
    productId: r.product_id,
    reviewNote: r.review_note ?? '',
    editedAt: r.edited_at ?? null,
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
  /**
   * 已经存在的产品档案：传入时**不另建产品**，直接把这条档案推到 pending_review。
   * 这是「同一份产品档案贯穿全流程」的关键 —— 从产品档案批量出文案时走这条路，
   * 编号/资料/评估/图片都还是原来那条，审核通过后原地变成正式产品。
   */
  productId?: string | null
}): { id: string; productId: string } {
  const id = randomUUID()
  const now = new Date().toISOString()

  // 产品先建出来（status=pending_review）：这样审核页可以直接用单品那套
  // 「英文链接生成」页面打开、编辑、看 QC —— 和单个生成时完全一样。
  // 产品库列表默认不含 pending_review，所以没审过的不会混进正式产品。
  let productId = input.productId ?? ''
  try {
    if (productId) {
      applyListingToExistingProduct(productId, {
        source: input.source,
        evaluation: input.evaluation,
        listing: input.listing,
        status: 'pending_review',
      })
    } else {
      productId = insertProduct({
        source: input.source,
        evaluation: input.evaluation,
        listing: input.listing,
        similar: null,
        status: 'pending_review',
        draftId: input.draftId ?? null,
      })
    }
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
 * 批量生产专用：把生成结果**暂存**成一条待审核记录，产品档案一个字都不动。
 *
 * 为什么必须这样：批量重新生成时如果沿用旧流程（生成即写 products），
 * 一次误点就会把产品库里已经审核通过的 Listing 覆盖掉，而且没有撤销入口。
 * 暂存模式下产品上的旧 listing 原样保留（同时抄一份到 prev_listing 备查），
 * 只有人工点「通过」才写回。
 */
export function createStagedListingReview(input: {
  productId: string
  listing: Listing
  qc?: ListingQcReport | null
  jobId?: string | null
  itemIdx?: number | null
  source: SourceInfo
  evaluation: Evaluation | null
}): { id: string; productId: string } {
  const id = randomUUID()
  const now = new Date().toISOString()

  // 同一个产品只允许有一份「还没审的暂存草稿」：
  // 不管是同一次任务重试、还是从审核中心再生成一次，都替换掉旧的，
  // 否则列表里会出现两条同产品的草稿，审核的人会分不清哪条是新的。
  db.prepare(
    "DELETE FROM listing_reviews WHERE product_id = ? AND mode = 'staged' AND status = 'pending'"
  ).run(input.productId)

  const current = db.prepare('SELECT listing FROM products WHERE id = ?').get(input.productId) as
    | { listing: string | null }
    | undefined
  const prevListingRaw = current?.listing ?? null

  db.prepare(
    `INSERT INTO listing_reviews
      (id, batch_job_id, batch_idx, job_id, item_idx, mode, qc, title, source_url, image, score, verdict,
       source, evaluation, listing, prev_listing, price_grid, status, product_id, review_note, created_at, updated_at)
     VALUES (?, NULL, NULL, ?, ?, 'staged', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '', ?, ?)`
  ).run(
    id,
    input.jobId ?? null,
    input.itemIdx ?? null,
    input.qc ? JSON.stringify(input.qc) : null,
    (input.source.sourceTitle || input.listing?.title || '（未命名）').slice(0, 200),
    input.source.sourceUrl ?? '',
    (input.source.images ?? [])[0] ?? '',
    input.evaluation?.score ?? null,
    input.evaluation?.verdict ?? null,
    JSON.stringify(input.source),
    input.evaluation ? JSON.stringify(input.evaluation) : null,
    JSON.stringify(input.listing ?? {}),
    prevListingRaw,
    JSON.stringify(input.listing?.priceGrid ?? []),
    input.productId,
    now,
    now
  )
  // 产品档案跟着翻成「待审核」，产品流水线才不会显示成「还没生成文案」。
  // 只翻 sourced 的：已经在预产品库里的产品重生成时不能被拉回流水线。
  try {
    db.prepare(
      "UPDATE products SET status='pending_review', updated_at=? WHERE id=? AND status='sourced'"
    ).run(now, input.productId)
  } catch {
    /* ignore */
  }
  return { id, productId: input.productId }
}
/** 通过 staged 记录时，把草稿写回产品档案（只有这一步会改 products.listing） */
function applyStagedListing(row: RawRow): void {
  if (!row.product_id) return
  const now = new Date().toISOString()
  const listing = parseJson<Partial<Listing>>(row.listing, {})
  db.prepare(
    "UPDATE products SET listing=?, listing_title=?, status='listed', review_state='approved', review_note='', reviewed_at=?, updated_at=? WHERE id=?"
  ).run(
    JSON.stringify(listing),
    String(listing.title ?? ''),
    now,
    now,
    row.product_id
  )
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
      `SELECT id, batch_job_id, batch_idx, job_id, item_idx, mode, qc, title, source_url, image, score, verdict,
              status, product_id, review_note, edited_at, created_at, updated_at
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
      jobId: r.job_id ?? null,
      itemIdx: r.item_idx ?? null,
      mode: r.mode ?? 'inline',
      qc: parseJson<ListingQcReport | null>((r.qc as string | null) ?? null, null),
      title: r.title,
      sourceUrl: r.source_url,
      image: r.image,
      score: r.score,
      verdict: r.verdict,
      status: r.status,
      productId: r.product_id,
      reviewNote: r.review_note,
      editedAt: r.edited_at ?? null,
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

/**
 * 导出批量生成结果（Excel）。
 * 只导出当前筛选出来的这些记录，字段与审核中心一致，方便直接发给同事或存档。
 * 注意：必须注册在 GET /:id 之前，否则 'export' 会被当成 id。
 */
listingReviewsRouter.get('/export', async (req: Request, res: Response) => {
  const ExcelJS = (await import('exceljs')).default
  const idsParam = String(req.query.ids ?? '').trim()
  const status = String(req.query.status ?? 'all')
  const ids = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean) : []

  let rows: RawRow[]
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',')
    rows = db
      .prepare(`SELECT * FROM listing_reviews WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as RawRow[]
  } else {
    rows =
      status === 'all'
        ? (db.prepare('SELECT * FROM listing_reviews ORDER BY created_at DESC LIMIT 500').all() as unknown as RawRow[])
        : (db
            .prepare('SELECT * FROM listing_reviews WHERE status = ? ORDER BY created_at DESC LIMIT 500')
            .all(status) as unknown as RawRow[])
  }

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('批量生成结果')
  ws.columns = [
    { header: '产品编号', key: 'code', width: 12 },
    { header: '产品名称', key: 'product', width: 30 },
    { header: 'Title', key: 'title', width: 50 },
    { header: 'Summary', key: 'summary', width: 50 },
    { header: 'Description', key: 'description', width: 60 },
    { header: 'Keywords', key: 'keywords', width: 60 },
    { header: '质检', key: 'qc', width: 30 },
    { header: '审核状态', key: 'status', width: 12 },
    { header: '驳回原因', key: 'note', width: 24 },
    { header: '生成时间', key: 'createdAt', width: 20 },
  ]
  ws.getRow(1).font = { bold: true }

  const statusText: Record<string, string> = { pending: '待审核', approved: '已通过', rejected: '已驳回' }

  for (const r of rows) {
    const listing = parseJson<Partial<Listing>>(r.listing, {})
    const qc = parseJson<ListingQcReport | null>(r.qc ?? null, null)
    const code = r.product_id
      ? ((db.prepare('SELECT code FROM products WHERE id = ?').get(r.product_id) as { code: string } | undefined)
          ?.code ?? '')
      : ''
    ws.addRow({
      code,
      product: r.title,
      title: listing.title ?? '',
      summary: listing.summary ?? '',
      description: listing.description ?? '',
      keywords: (listing.keywords ?? []).join(', '),
      qc: qc
        ? qc.ok
          ? qc.aiChecked
            ? '通过（含 AI 复检）'
            : '通过（程序规则）'
          : qc.checks
              .filter((c) => !c.ok)
              .map((c) => c.label)
              .join('；')
        : '未检查',
      status: statusText[r.status] ?? r.status,
      note: r.review_note ?? '',
      createdAt: r.created_at,
    })
  }

  const buf = await wb.xlsx.writeBuffer()
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  res.setHeader('Content-Disposition', 'attachment; filename="listing-batch-result.xlsx"')
  res.send(Buffer.from(buf as ArrayBuffer))
})

/**
 * 批量 AI 复检：对选中的待审核记录逐条跑「语法 / 美国英语 / 无依据说法」检查。
 * 单独一个动作，不默认跟着生成跑 —— 一条一次模型调用，批量时成本会翻倍。
 */
listingReviewsRouter.post('/ai-qc', async (req: Request, res: Response) => {
  const body = z
    .object({ ids: z.array(z.string().min(1)).min(1).max(20).optional() })
    .parse(req.body ?? {})
  const settings = loadSettings()
  if (!settings.aiApiKey?.trim()) throw new AppError(400, '还没配置 AI Key，无法复检')

  const ids =
    body.ids ??
    (db
      .prepare("SELECT id FROM listing_reviews WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10")
      .all() as unknown as Array<{ id: string }>).map((r) => r.id)

  const results: Array<{ id: string; ok: boolean; findings: string[]; error?: string }> = []
  for (const id of ids) {
    try {
      const row = db.prepare('SELECT * FROM listing_reviews WHERE id = ?').get(id) as unknown as RawRow | undefined
      if (!row) {
        results.push({ id, ok: false, findings: [], error: '记录不存在' })
        continue
      }
      const review = toReview(row)
      const specRecord = row.product_id ? getSpecRecord(row.product_id) : null
      const base = runListingQc({ listing: review.listing, source: review.source, specs: specRecord?.specs ?? null })
      const ai = await runAiListingQc(
        review.listing,
        review.source,
        specRecord?.specs ?? null,
        settings,
        row.product_id
      )
      const qc = mergeAiQc(base, ai.findings)
      db.prepare('UPDATE listing_reviews SET qc=?, updated_at=? WHERE id=?').run(
        JSON.stringify(qc),
        new Date().toISOString(),
        id
      )
      results.push({ id, ok: qc.ok, findings: ai.findings })
    } catch (err) {
      // 单条复检失败不影响其他条
      results.push({ id, ok: false, findings: [], error: err instanceof Error ? err.message : String(err) })
    }
  }
  res.json({ ok: true, results })
})

/**
 * 只重生成指定字段（标题/摘要/描述/关键词），结果并回这条草稿。
 * 不重跑整条 Listing —— 用户往往只对某一段不满意，没必要为改一句标题再等一分钟。
 */
listingReviewsRouter.post('/:id/regenerate-fields', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const row = db.prepare('SELECT * FROM listing_reviews WHERE id = ?').get(id) as unknown as RawRow | undefined
  if (!row) throw new AppError(404, '这条待审核记录不存在')
  if (row.status === 'approved') throw new AppError(409, '已经通过的不能再改，请到产品库里改')

  const body = z
    .object({
      fields: z.array(z.enum(['title', 'summary', 'description', 'keywords'])).min(1).max(4),
      instruction: z.string().max(2000).optional(),
    })
    .parse(req.body ?? {})

  const settings = loadSettings()
  if (!settings.aiApiKey?.trim()) throw new AppError(400, '还没配置 AI Key，无法重生成')
  const review = toReview(row)
  if (!row.product_id) throw new AppError(400, '这条记录没有关联产品，无法重生成')

  const product = findProduct(row.product_id)
  const specRecord = getSpecRecord(row.product_id)
  // 结构化资料作为「事实清单」拼进指令，避免重生成时又编造参数
  const instruction = [body.instruction, specsInstruction(specRecord?.specs ?? null)].filter(Boolean).join('\n\n')

  const values = await regenerateListingFields(
    product.source,
    review.listing as Partial<Listing>,
    body.fields,
    instruction || undefined,
    settings,
    product.evaluation ?? null
  )
  const merged = { ...(review.listing as unknown as Record<string, unknown>), ...values } as unknown as Listing
  const qc = runListingQc({ listing: merged, source: product.source, specs: specRecord?.specs ?? null })
  const now = new Date().toISOString()
  db.prepare('UPDATE listing_reviews SET listing=?, qc=?, edited_at=?, updated_at=? WHERE id=?').run(
    JSON.stringify(merged),
    JSON.stringify(qc),
    now,
    now,
    id
  )
  res.json({ review: toReview({ ...row, listing: JSON.stringify(merged), qc: JSON.stringify(qc), edited_at: now }), values, qc })
})

/** 把结构化资料写成「重生成时必须遵守的事实」 */
function specsInstruction(specs: import('../types').ProductSpecs | null): string {
  if (!specs) return ''
  const lines = SPEC_FIELDS.filter((f) => isKnown(specs[f.key])).map(
    (f) => `- ${f.labelEn}: ${String(specs[f.key]).trim()}`
  )
  if (!lines.length) return ''
  return `产品事实清单（只能使用这些事实，没写的不要编）：\n${lines.join('\n')}`
}

/** 单条 AI 复检 */
listingReviewsRouter.post('/:id/ai-qc', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const row = db.prepare('SELECT * FROM listing_reviews WHERE id = ?').get(id) as unknown as RawRow | undefined
  if (!row) throw new AppError(404, '这条待审核记录不存在')
  const settings = loadSettings()
  if (!settings.aiApiKey?.trim()) throw new AppError(400, '还没配置 AI Key，无法复检')

  const review = toReview(row)
  const specRecord = row.product_id ? getSpecRecord(row.product_id) : null
  const base = runListingQc({ listing: review.listing, source: review.source, specs: specRecord?.specs ?? null })
  const ai = await runAiListingQc(review.listing, review.source, specRecord?.specs ?? null, settings, row.product_id)
  const qc = mergeAiQc(base, ai.findings)
  db.prepare('UPDATE listing_reviews SET qc=?, updated_at=? WHERE id=?').run(JSON.stringify(qc), new Date().toISOString(), id)
  res.json({ qc, findings: ai.findings })
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

  // 审核时要能改整套英文链接信息（不只是正文四段）：分类/主题/材质/颜色/印刷/包装/规格/注意事项/中文对照都能改。
  // 报价表不在这里改（它由报价引擎算，改了会和成本脱节）。
  const body = z
    .object({
      listing: z
        .object({
          title: z.string().max(2000).optional(),
          summary: z.string().max(20000).optional(),
          description: z.string().max(60000).optional(),
          keywords: z.array(z.string().max(200)).max(200).optional(),
          category: z.string().max(300).optional(),
          categories: z.array(z.string().max(300)).max(10).optional(),
          typeOfProduct: z.string().max(300).optional(),
          themes: z.array(z.string().max(200)).max(20).optional(),
          material: z.string().max(500).optional(),
          materials: z.array(z.string().max(200)).max(20).optional(),
          colors: z.string().max(1000).optional(),
          colorChips: z.array(z.string().max(120)).max(60).optional(),
          imprintMethods: z.array(z.string().max(120)).max(30).optional(),
          imprintArea: z.string().max(1000).optional(),
          productionTime: z.string().max(300).optional(),
          packaging: z.string().max(2000).optional(),
          warnings: z.array(z.string().max(1000)).max(20).optional(),
          productSizeInch: z.string().max(300).optional(),
          unitWeightLb: z.union([z.number(), z.string(), z.null()]).optional(),
          cartonSizeInch: z.string().max(300).optional(),
          cartonGwLb: z.union([z.number(), z.string(), z.null()]).optional(),
          titleZh: z.string().max(2000).optional(),
          summaryZh: z.string().max(20000).optional(),
          descriptionZh: z.string().max(60000).optional(),
          keywordsZh: z.string().max(60000).optional(),
        })
        .optional(),
    })
    .parse(req.body ?? {})

  if (body.listing) {
    const merged = { ...parseJson<Record<string, unknown>>(row.listing, {}), ...body.listing }
    // 改完立刻按最新内容重跑程序质检，避免显示的还是改动前的结论
    let qc: unknown = null
    try {
      qc = runListingQc({ listing: merged })
    } catch {
      qc = null
    }
    const now = new Date().toISOString()
    db.prepare('UPDATE listing_reviews SET listing=?, qc=?, edited_at=?, updated_at=? WHERE id=?').run(
      JSON.stringify(merged),
      qc ? JSON.stringify(qc) : row.qc ?? null,
      now,
      now,
      id
    )
  }
  const fresh = db.prepare('SELECT * FROM listing_reviews WHERE id = ?').get(id) as unknown as RawRow
  res.json({ review: toReview(fresh) })
})

/**
 * 通过。
 *  - inline 模式（旧流程）：产品已经是 pending_review，只把状态翻成 listed
 *  - staged 模式（批量生产）：把这条草稿写回产品档案（listing + listing_title），再翻状态
 * 两种模式都不会重建产品、不会动资料/评估/图片。
 */
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

      // 硬规矩：没生成英文链接（标题/摘要/描述全空）就不能通过审核
      try {
        const parsed = parseJson<{ title?: string; summary?: string; description?: string }>(row.listing, {})
        if (!parsed.title && !parsed.summary && !parsed.description) {
          failed.push({ id, error: '还没生成英文链接，不能通过审核' })
          continue
        }
      } catch {
        failed.push({ id, error: '英文文案解析失败，先重新生成再审核' })
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

      if (row.mode === 'staged') {
        // 只有这一步会写入 products.listing —— 批量生成本身从不覆盖产品库
        applyStagedListing({ ...row, product_id: productId })
      } else {
        db.prepare(
          "UPDATE products SET status='listed', review_state='approved', updated_at=? WHERE id=?"
        ).run(now, productId)
      }
      // 进预产品库：发 GLS 编号（已发过就不重发），编号规则见 services/numbering.ts
      try {
        enterPreLibrary(productId)
      } catch {
        /* 发号失败不让审核本身失败，下次通过或补录时会再补 */
      }
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

/**
 * 驳回，附一句原因。
 *  - inline：产品还在 pending_review，标成 archived（不进产品库）
 *  - staged：**产品上的旧 Listing 保持不动**，只把这条草稿标成 rejected。
 *    批量重新生成被驳回，不能让已经在卖的产品掉出产品库。
 */
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
    const row = db.prepare('SELECT product_id, status, mode FROM listing_reviews WHERE id = ?').get(id) as
      | { product_id: string | null; status: string; mode: string | null }
      | undefined
    if (!row || row.status === 'approved') continue
    db.prepare(
      "UPDATE listing_reviews SET status='rejected', review_note=?, updated_at=? WHERE id=?"
    ).run(body.note ?? '', now, id)
    if (row.product_id && row.mode === 'staged') {
      // 暂存草稿被驳回：产品退回「已评估、待生成文案」，资料和评估都不动
      db.prepare(
        "UPDATE products SET status='sourced', review_note=?, updated_at=? WHERE id=? AND status='pending_review'"
      ).run(body.note ?? '', now, row.product_id)
    } else if (row.product_id) {
      db.prepare(
        "UPDATE products SET status='archived', review_state='rejected', review_note=?, updated_at=? WHERE id=?"
      ).run(body.note ?? '', now, row.product_id)
    }
    n += 1
  }
  res.json({ ok: true, rejected: n })
})

/**
 * 驳回「已经通过」的文案（通过之后反悔）。
 *
 * 效果：这条审核记录标成已驳回，产品从预产品库下架（status=archived、library_state=pipeline），
 * 文案内容保留 —— 可以改完重新生成、再走一次审核。GLS 号留在产品上（下次通过继续用，不重号）。
 */
listingReviewsRouter.post('/unapprove', (req: Request, res: Response) => {
  const body = z
    .object({ ids: z.array(z.string().min(1)).min(1).max(200), note: z.string().max(500).optional() })
    .parse(req.body ?? {})
  const now = new Date().toISOString()
  const reverted: string[] = []
  const skipped: Array<{ id: string; error: string }> = []

  for (const id of body.ids) {
    const row = db.prepare('SELECT * FROM listing_reviews WHERE id = ?').get(id) as unknown as RawRow | undefined
    if (!row) {
      skipped.push({ id, error: '记录不存在' })
      continue
    }
    if (row.status !== 'approved') {
      skipped.push({ id, error: '只有「已通过」的才能驳回' })
      continue
    }
    db.prepare("UPDATE listing_reviews SET status='rejected', review_note=?, updated_at=? WHERE id=?").run(
      body.note ?? '',
      now,
      id
    )
    if (row.product_id) {
      db.prepare(
        "UPDATE products SET status='archived', review_state='rejected', review_note=?, library_state='pipeline', reviewed_at=?, updated_at=? WHERE id=?"
      ).run(body.note ?? '', now, now, row.product_id)
    }
    reverted.push(id)
  }
  res.json({ ok: true, reverted: reverted.length, skipped })
})

/** 删除（不留档）：**产品档案不删**，只把待审核的那条记录删掉并把档案退回「文案待生成」 */
listingReviewsRouter.post('/bulk-delete', (req: Request, res: Response) => {
  const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).parse(req.body ?? {})
  const now = new Date().toISOString()
  let n = 0
  for (const id of body.ids) {
    const row = db.prepare('SELECT product_id, status, mode FROM listing_reviews WHERE id = ?').get(id) as
      | { product_id: string | null; status: string; mode: string | null }
      | undefined
    // staged 草稿删掉即可：产品上的 listing 从来没被动过，不需要回退
    if (row?.product_id && row.status !== 'approved' && row.mode === 'staged') {
      db.prepare(
        "UPDATE products SET status='sourced', updated_at=? WHERE id=? AND status='pending_review'"
      ).run(now, row.product_id)
    } else if (row?.product_id && row.status !== 'approved') {
      // 待审核的档案退回「已评估、未生成文案」：不丢资料、不丢评估，随时可以重新生成
      db.prepare(
        "UPDATE products SET status='sourced', listing=NULL, review_state=NULL, updated_at=? WHERE id=? AND status='pending_review'"
      ).run(now, row.product_id)
    }
    n += Number(db.prepare('DELETE FROM listing_reviews WHERE id = ?').run(id).changes ?? 0)
  }
  res.json({ ok: true, removed: n })
})

listingReviewsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const row = db.prepare('SELECT product_id, status, mode FROM listing_reviews WHERE id = ?').get(id) as
    | { product_id: string | null; status: string; mode: string | null }
    | undefined
  if (!row) throw new AppError(404, '记录不存在')
  if (row.product_id && row.status !== 'approved' && row.mode === 'staged') {
    db.prepare(
      "UPDATE products SET status='sourced', updated_at=? WHERE id=? AND status='pending_review'"
    ).run(new Date().toISOString(), row.product_id)
  } else if (row.product_id && row.status !== 'approved') {
    db.prepare(
      "UPDATE products SET status='sourced', listing=NULL, review_state=NULL, updated_at=? WHERE id=? AND status='pending_review'"
    ).run(new Date().toISOString(), row.product_id)
  }
  db.prepare('DELETE FROM listing_reviews WHERE id = ?').run(id)
  res.json({ ok: true })
})
