import { randomUUID } from 'crypto'
import iconv from 'iconv-lite'
import { saveSourcingHistory } from './sourcing-history'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { AiError, callChatJson } from '../services/ai'
import { probeWithDiag } from '../services/market-probe'
import { applyMemberDiscount } from '../services/market-probe'
import { buildVisualPriceCheck } from '../services/visual-price'
import { formOfSource } from '../services/market-text'
import { applyQc, assistantChat, chatEvaluateSource, evaluateSource, findSimilarForSource, generateListing, generateListingQuestions, hasSimilarResearch, regenerateListingFields, researchQueryEn, researchSourcing, suggestSourcing } from '../services/workbench'
import type { ResearchMatch } from '../services/workbench'
import { buildFindSimilarPrompt, ChatMessage, ListingAnswer } from '../services/prompts'
import { buildPriceGrid, convertUnits, retogglePriceRow } from '../services/pricing'
import type { Settings } from '../types'
import { buildGlsWorkbook } from '../services/gls-export'
import { recommendImprintMethods } from '../services/imprint-recommend'
import { Evaluation, Listing, PriceRow, Product, ProductStatus, SimilarResearch, SourceInfo } from '../types'
import { loadSettings } from './settings'
import { env } from '../config/env'
import { computeScoreV2 } from '../services/scoring'
import { createTask, getTask, runTask, TaskRecord, updateTask } from '../services/task-manager'
import { applyProductSourceToMaster, findMasterByUrl, MasterProduct } from './master-products'

export const productsRouter: Router = Router()

export const sourceSchema = z.object({
  sourceTitle: z.string().default(''),
  sourceUrl: z.string().default(''),
  description: z.string().default(''),
  sourceKeywords: z.array(z.string()).default([]),
  amazonTitle: z.string().default(''),
  priceCny: z.coerce.number().nullable().optional(),
  priceMaxCny: z.coerce.number().nullable().optional(),
  moq: z.coerce.number().nullable().optional(),
  supplier: z.string().default(''),
  /** 备选供应商（每行一个） */
  altSuppliers: z.string().default(''),
  materialCn: z.string().default(''),
  colorsCn: z.string().default(''),
  sizeCn: z.string().default(''),
  weightG: z.coerce.number().nullable().optional(),
  cartonLCm: z.coerce.number().nullable().optional(),
  cartonWCm: z.coerce.number().nullable().optional(),
  cartonHCm: z.coerce.number().nullable().optional(),
  pcsPerCarton: z.coerce.number().nullable().optional(),
  cartonGwKg: z.coerce.number().nullable().optional(),
  images: z.array(z.string()).default([]),
  category: z.string().default(''),
  notes: z.string().default(''),
})

const createSchema = z.object({
  source: sourceSchema,
  evaluation: z.any().nullable().optional(),
  listing: z.any().nullable().optional(),
  similar: z.any().nullable().optional(),
  status: z.enum(['sourced', 'listed', 'archived', 'pending_review']).optional(),
  /** 关联的选品评估草稿 id：同一草稿重复保存时更新已关联产品，避免重复建品 */
  draftId: z.string().max(100).optional(),
})

const updateSchema = z.object({
  source: sourceSchema.partial().optional(),
  evaluation: z.any().nullable().optional(),
  listing: z.any().nullable().optional(),
  status: z.enum(['sourced', 'listed', 'archived', 'pending_review']).optional(),
})

type SourceInput = z.infer<typeof sourceSchema>

export function toSourceInfo(s: SourceInput): SourceInfo {
  return {
    sourceTitle: s.sourceTitle ?? '',
    sourceUrl: s.sourceUrl ?? '',
    description: s.description ?? '',
    sourceKeywords: s.sourceKeywords ?? [],
    amazonTitle: s.amazonTitle ?? '',
    priceCny: Number(s.priceCny ?? 0),
    priceMaxCny: s.priceMaxCny ?? null,
    moq: Number(s.moq ?? 0),
    supplier: s.supplier ?? '',
    altSuppliers: s.altSuppliers ?? '',
    materialCn: s.materialCn ?? '',
    colorsCn: s.colorsCn ?? '',
    sizeCn: s.sizeCn ?? '',
    weightG: s.weightG ?? null,
    cartonLCm: s.cartonLCm ?? null,
    cartonWCm: s.cartonWCm ?? null,
    cartonHCm: s.cartonHCm ?? null,
    pcsPerCarton: s.pcsPerCarton ?? null,
    cartonGwKg: s.cartonGwKg ?? null,
    images: s.images ?? [],
    category: s.category ?? '',
    notes: s.notes ?? '',
  }
}

interface Row {
  id: string
  code: string
  draft_id: string | null
  source_title: string
  source_url: string
  description: string
  source_keywords: string
  price_settings?: string | null
  library_state?: string | null
  amazon_title: string
  price_cny: number | null
  price_max_cny: number | null
  moq: number | null
  supplier: string
  alt_suppliers: string
  material_cn: string
  colors_cn: string
  size_cn: string
  weight_g: number | null
  carton_l_cm: number | null
  carton_w_cm: number | null
  carton_h_cm: number | null
  pcs_per_carton: number | null
  carton_gw_kg: number | null
  images: string
  category: string
  notes: string
  score: number | null
  verdict: string | null
  evaluation: string | null
  listing: string | null
  similar: string | null
  status: string
  created_at: string
  updated_at: string
  trashed_at: string | null
  score_v2: number | null
  verdict_v2: string | null
  margin_v2: number | null
  ceiling_cny: number | null
  scored_at: string | null
  review_state: string | null
  review_note: string | null
  reject_reasons: string | null
  reviewed_at: string | null
  origin: string | null
  selection_reason: string | null
  market_list_low: number | null
  market_list_high: number | null
  market_source: string | null
  market_checked_at: string | null
}

const parseJson = <T>(v: string | null, fallback: T): T => {
  if (!v) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

function rowToProduct(r: Row): Product {
  return {
    id: r.id,
    code: r.code ?? '',
    draftId: r.draft_id ?? null,
    source: {
      sourceTitle: r.source_title,
      sourceUrl: r.source_url,
      description: r.description ?? '',
      sourceKeywords: parseJson<string[]>(r.source_keywords, []),
      amazonTitle: r.amazon_title ?? '',
      priceCny: r.price_cny ?? 0,
      priceMaxCny: r.price_max_cny,
      moq: r.moq ?? 0,
      supplier: r.supplier,
      altSuppliers: r.alt_suppliers ?? '',
      materialCn: r.material_cn,
      colorsCn: r.colors_cn,
      sizeCn: r.size_cn,
      weightG: r.weight_g,
      cartonLCm: r.carton_l_cm,
      cartonWCm: r.carton_w_cm,
      cartonHCm: r.carton_h_cm,
      pcsPerCarton: r.pcs_per_carton,
      cartonGwKg: r.carton_gw_kg,
      images: parseJson<string[]>(r.images, []),
      category: r.category,
      notes: r.notes,
    },
    evaluation: migrateEvaluation(parseJson<Evaluation | null>(r.evaluation, null)),
    listing: migrateListing(parseJson<any>(r.listing, null)),
    similar: parseJson<SimilarResearch | null>(r.similar, null),
    status: r.status as ProductStatus,
    ...(r.price_settings ? { priceSettings: parseJson(r.price_settings, null) } : {}),
    libraryState: r.library_state ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    trashedAt: r.trashed_at ?? null,
    scoreV2: r.score_v2 ?? null,
    verdictV2: (r.verdict_v2 as 'GO' | 'NEGOTIATE' | 'NO' | null) ?? null,
    marginV2: r.margin_v2 ?? null,
    ceilingCny: r.ceiling_cny ?? null,
    scoredAt: r.scored_at ?? null,
    reviewState: (r.review_state as 'pending' | 'approved' | 'rejected' | 'parked' | null) ?? null,
    rejectReasons: parseJson<string[]>(r.reject_reasons, []),
    reviewNote: r.review_note ?? null,
    reviewedAt: r.reviewed_at ?? null,
    origin: (r.origin as 'manual' | 'auto' | null) ?? 'manual',
    selectionReason: r.selection_reason ?? null,
    marketListLow: r.market_list_low ?? null,
    marketListHigh: r.market_list_high ?? null,
    marketSource: r.market_source ?? null,
    marketCheckedAt: r.market_checked_at ?? null,
  }
}

/** 老版本 Listing JSON → 新字段结构（保证前端不再读 undefined 字段） */
function migrateListing(l: any): Listing | null {
  if (!l) return null
  if (typeof l.summary !== 'string' && typeof l.shortDescription === 'string') {
    const trimmed = l.shortDescription.trim()
    l.summary = trimmed
      ? `${trimmed.replace(/[.\s]+$/, '')} Rush service is available`
      : 'Rush service is available'
  }
  if (!Array.isArray(l.themes) || l.themes.length === 0) {
    l.themes = ['Anniversary', 'Sustainable']
  }
  if (!Array.isArray(l.colorChips)) {
    l.colorChips = typeof l.colors === 'string'
      ? l.colors.split('/').map((s: string) => s.trim()).filter(Boolean)
      : []
  }
  if (typeof l.colors !== 'string') l.colors = (l.colorChips ?? []).join('/')
  if (!Array.isArray(l.keywords)) l.keywords = []
  if (!Array.isArray(l.imprintMethods)) l.imprintMethods = []
  if (!Array.isArray(l.warnings)) l.warnings = []
  // 需求 4：老数据的 material 可能是 "A, B" 或单值，统一补出 materials 数组
  if (!Array.isArray(l.materials) || l.materials.length === 0) {
    const src = typeof l.material === 'string' ? l.material : ''
    const parts = src
      .split(/[,/]/)
      .map((s: string) => s.trim())
      .filter(Boolean)
    l.materials = parts.length ? parts : src.trim() ? [src.trim()] : []
  }
  if (!l.material && l.materials?.length) l.material = l.materials[0]
  l.title = typeof l.title === 'string' ? l.title : ''
  l.summary = typeof l.summary === 'string' ? l.summary : ''
  l.description = typeof l.description === 'string' ? l.description : ''
  l.titleZh = l.titleZh ?? ''
  l.summaryZh = l.summaryZh ?? ''
  l.descriptionZh = l.descriptionZh ?? l.description ?? ''
  l.keywordsZh = l.keywordsZh ?? (Array.isArray(l.keywords) ? l.keywords.join(', ') : '')
  l.productSizeInch = l.productSizeInch ?? ''
  l.unitWeightLb = l.unitWeightLb ?? null
  l.cartonSizeInch = l.cartonSizeInch ?? ''
  l.cartonGwLb = l.cartonGwLb ?? null
  // 读取时统一过一遍 ASI 合规：补必填印刷方式 / 主题，并按真实长度重算 QC
  return applyQc(l as Listing)
}

/** 老评估数据缺 issues / suggestions 时兜底（需求 3） */
function migrateEvaluation(e: Evaluation | null): Evaluation | null {
  if (!e) return e
  if (!Array.isArray(e.issues) || e.issues.length === 0) {
    e.issues = Array.isArray(e.cons) && e.cons.length ? e.cons : ['该评估未记录具体弱点，建议重新评估']
  }
  if (!Array.isArray(e.suggestions) || e.suggestions.length === 0) {
    e.suggestions = ['点「AI 选品评估」重新跑一次，可拿到针对每条弱点的改进策略']
  }
  return e
}

export function findProduct(id: string): Product {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as unknown as Row | undefined
  if (!row) throw new AppError(404, '产品不存在')
  return rowToProduct(row)
}

/**
 * 单产品定价参数：把产品上的 priceSettings 覆盖到全局设置上。
 * 为什么需要：不同产品印刷处数、运费谈判价都不一样，必须能逐产品调，
 * 而不是改一次全局设置影响所有产品。
 */
const PRICE_KEYS = [
  'fxRate',
  'airRateCnyPerKg',
  'seaRateCnyPerKg',
  'volumetricDivisor',
  'markupAir',
  'markupSea',
  'printCostCny',
  'sampleFeeCny',
  'miscFeePct',
  'espMemberDiscount',
  'rounding',
] as const

export function settingsForProduct(product: { priceSettings?: Record<string, unknown> | null }): Settings {
  const base = loadSettings()
  const over = product.priceSettings
  if (!over || typeof over !== 'object') return base
  const merged: Settings = { ...base }
  for (const k of PRICE_KEYS) {
    const v = (over as Record<string, unknown>)[k]
    if (typeof v === 'number' && Number.isFinite(v)) (merged as unknown as Record<string, number>)[k] = v
  }
  return merged
}

/** 库状态：'' 普通 / 'pre' 预产品库 / 'rpa' RPA 档案库 */
function libraryStateOf(id: string): string {
  const r = db.prepare('SELECT library_state FROM products WHERE id = ?').get(id) as
    | { library_state?: string | null }
    | undefined
  return r?.library_state ?? ''
}

/**
 * RPA 锁：进了 RPA 档案库的产品默认不允许改任何信息。
 * 前端确认"确实要改"后带 force=true 重试；这时先留一版历史再改（保存后版本 +1）。
 */
function assertEditable(id: string, force: unknown, reason: string) {
  const forced = force === true || force === 'true' || force === 1
  if (forced) {
    recordRevision(id, reason)
    return
  }
  if (libraryStateOf(id) === 'rpa') {
    throw new AppError(
      409,
      'RPA_LOCKED：该产品已进入 RPA 档案库，修改会影响已上架信息。确认修改请点「仍然修改」（会生成新版本）'
    )
  }
}

/** 记一版历史（存改之前的 listing/source），并把版本号 +1 */
function recordRevision(id: string, reason: string) {
  try {
    const row = db.prepare('SELECT listing, source, COALESCE(rev,0) AS rev FROM products WHERE id = ?').get(id) as
      | { listing: string | null; source: string | null; rev: number }
      | undefined
    if (!row) return
    db.prepare(
      'INSERT INTO product_revisions (id, product_id, rev, reason, listing, source, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(
      randomUUID(),
      id,
      row.rev + 1,
      reason,
      row.listing,
      row.source,
      new Date().toISOString()
    )
    db.prepare('UPDATE products SET rev = ? WHERE id = ?').run(row.rev + 1, id)
  } catch {
    // 留底失败不阻塞保存
  }
}

export async function runAi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AiError) {
      throw new AppError(502, err.hint ? `${err.message}｜${err.hint}` : err.message)
    }
    throw err
  }
}

// ---------- 列表 ----------
productsRouter.get('/', async (req: Request, res: Response) => {
  const status = (req.query.status as string) || ''
  const q = ((req.query.q as string) || '').trim()
  // 默认排除回收站（status='trashed'）；只有显式 status='trashed' 才返回回收站
  const where: string[] = []
  const params: unknown[] = []
  if (status === 'trashed') {
    where.push("status = 'trashed'")
  } else if (status) {
    where.push('status = ?')
    params.push(status)
  } else {
    // 默认排除回收站和「英文链接待审核」：后者在待审核页里审，审过才算正式产品
    where.push("status != 'trashed' AND status != 'pending_review'")
  }
  if (q) {
    where.push('(source_title LIKE ? OR listing LIKE ? OR category LIKE ? OR amazon_title LIKE ?)')
    const like = `%${q}%`
    params.push(like, like, like, like)
  }
  let sql = 'SELECT * FROM products'
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`
  sql += ' ORDER BY updated_at DESC LIMIT 500'
  const rows = db.prepare(sql).all(...params) as unknown as Row[]
  res.json({ products: rows.map(rowToProduct) })
})

// ---------- 评分 v2：按市场 list 反算能不能赚钱 ----------
// 只写 score_v2 / verdict_v2 / margin_v2 / ceiling_cny / scored_at 这几个新增列，
// 原来的 score / verdict / evaluation 一律不动，方便对照。

function computeRowScore(row: Row) {
  const settings = loadSettings()
  const evaluation = parseJson<any>(row.evaluation, null)
  const listing = parseJson<any>(row.listing, null)
  const similar = parseJson<any>(row.similar, null)
  const manual =
    row.market_list_low != null && row.market_list_high != null
      ? { min: row.market_list_low, max: row.market_list_high }
      : null
  return computeScoreV2(
    {
      priceCny: row.price_cny ?? null,
      marketList: manual,
      priceAdviceUsd: evaluation?.priceAdviceUsd ?? null,
      similarPriceRangeUsd: similar?.priceRangeUsd ?? null,
      priceGrid: listing?.priceGrid ?? [],
      asiCategories: evaluation?.asiCategories ?? [],
    },
    settings.fxRate
  )
}

/** 全量重算（不动原评分），返回各类判定条数 */
productsRouter.post('/rescore-all', async (_req: Request, res: Response) => {
  const rows = db
    .prepare("SELECT * FROM products WHERE status != 'trashed'")
    .all() as unknown as Row[]
  const now = new Date().toISOString()
  const stmt = db.prepare(
    'UPDATE products SET score_v2=?, verdict_v2=?, margin_v2=?, ceiling_cny=?, scored_at=? WHERE id=?'
  )
  const counts = { GO: 0, NEGOTIATE: 0, NO: 0, UNKNOWN: 0 }
  for (const row of rows) {
    const s = computeRowScore(row)
    counts[s.verdict] += 1
    stmt.run(s.score, s.verdict, s.margin, s.ceilingCny, now, row.id)
  }
  res.json({ updated: rows.length, counts })
})

/** 单条重算 */
productsRouter.post('/:id/rescore', async (req: Request, res: Response) => {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id) as unknown as
    | Row
    | undefined
  if (!row) throw new AppError(404, '产品不存在')
  const s = computeRowScore(row)
  db.prepare(
    'UPDATE products SET score_v2=?, verdict_v2=?, margin_v2=?, ceiling_cny=?, scored_at=? WHERE id=?'
  ).run(s.score, s.verdict, s.margin, s.ceilingCny, new Date().toISOString(), row.id)
  res.json({ scoreV2: s })
})

// ---------- 审核队列 ----------
// 状态：pending 待审 / approved 通过 / parked 待询价 / rejected 否决（带理由标签）

const reviewBodySchema = z.object({
  state: z.enum(['pending', 'approved', 'rejected', 'parked']),
  reasons: z.array(z.string().max(40)).max(10).optional(),
  note: z.string().max(1000).optional(),
})

function applyReview(
  ids: string[],
  body: { state: string; reasons?: string[]; note?: string }
): number {
  const now = new Date().toISOString()
  const stmt = db.prepare(
    'UPDATE products SET review_state=?, reject_reasons=?, review_note=?, reviewed_at=? WHERE id=?'
  )
  for (const id of ids) {
    stmt.run(body.state, JSON.stringify(body.reasons ?? []), body.note ?? null, now, id)
  }
  return ids.length
}

/** 批量审核（一次最多 200 条） */
productsRouter.post('/review-bulk', async (req: Request, res: Response) => {
  const body = reviewBodySchema
    .extend({ ids: z.array(z.string()).min(1).max(200) })
    .parse(req.body)
  const updated = applyReview(body.ids, body)
  res.json({ updated })
})

/** 单条审核 */
productsRouter.post('/:id/review', async (req: Request, res: Response) => {
  const body = reviewBodySchema.parse(req.body)
  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id)
  if (!existing) throw new AppError(404, '产品不存在')
  applyReview([req.params.id], body)
  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id) as unknown as Row
  res.json({ product: rowToProduct(updated) })
})

// ---------- 市场参考价（人工在 ESP 同款核价） ----------
const marketPriceSchema = z.object({
  low: z.coerce.number().min(0).max(100000),
  high: z.coerce.number().min(0).max(100000),
  source: z.string().max(60).optional(),
})

productsRouter.post('/:id/market-price', async (req: Request, res: Response) => {
  const body = marketPriceSchema.parse(req.body ?? {})
  const row = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id)
  if (!row) throw new AppError(404, '产品不存在')
  const now = new Date().toISOString()

  // low=high=0 → 清空（误填时用），退回 AI 估价口径
  const clearing = body.low === 0 && body.high === 0
  if (!clearing && body.high < body.low) throw new AppError(400, '上限不能小于下限')

  db.prepare(
    'UPDATE products SET market_list_low=?, market_list_high=?, market_source=?, market_checked_at=? WHERE id=?'
  ).run(
    clearing ? null : body.low,
    clearing ? null : body.high,
    clearing ? null : (body.source ?? 'ESP'),
    clearing ? null : now,
    req.params.id
  )

  const fresh = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id) as unknown as Row
  const s = computeRowScore(fresh)
  db.prepare(
    'UPDATE products SET score_v2=?, verdict_v2=?, margin_v2=?, ceiling_cny=?, scored_at=? WHERE id=?'
  ).run(s.score, s.verdict, s.margin, s.ceilingCny, now, req.params.id)

  res.json({ product: findProduct(req.params.id), scoreV2: s, cleared: clearing })
})

// ---------- 外部任务导入（GitHub Actions 每日选品） ----------
// 只负责「把外面抓好的候选写进来」，重活在外部跑；AI 评估由脚本逐条调 /:id/evaluate。
const importSchema = z.object({
  items: z
    .array(
      z.object({
        source: sourceSchema,
        selectionReason: z.string().max(600).optional(),
      })
    )
    .min(1)
    .max(50),
})

productsRouter.post('/import', async (req: Request, res: Response) => {
  if (!env.SYNC_TOKEN || (req.get('x-sync-token') ?? '') !== env.SYNC_TOKEN) {
    throw new AppError(401, '同步令牌无效或未配置')
  }
  const body = importSchema.parse(req.body ?? {})
  const already = existingOfferIds()
  const created: Array<{ id: string; title: string; reason: string }> = []
  const skipped: string[] = []

  for (const item of body.items) {
    const s = toSourceInfo(item.source)
    const offerId = (s.sourceUrl || '').match(/offer\/(\d{6,})/)?.[1]
    if (offerId && already.has(offerId)) {
      skipped.push(`${offerId} 已存在`)
      continue
    }
    const reason = item.selectionReason || '外部定时任务导入'
    const id = insertAutoProduct(s, null, reason)
    if (offerId) already.add(offerId)
    created.push({ id, title: s.sourceTitle, reason })
  }

  res.json({ ok: true, created, skipped })
})

// ---------- 回收站统计 ----------
productsRouter.get('/recycle-bin/stats', async (_req: Request, res: Response) => {
  const r = db.prepare("SELECT COUNT(*) c FROM products WHERE status = 'trashed'").get() as { c: number }
  res.json({ trashedCount: r.c })
})

// ---------- 导出 CSV ----------
productsRouter.get('/export.csv', async (req: Request, res: Response) => {
  const includeTrashed = req.query.include_trashed === '1' || req.query.include_trashed === 'true'
  const sql = includeTrashed
    ? 'SELECT * FROM products ORDER BY updated_at DESC'
    : "SELECT * FROM products WHERE status != 'trashed' ORDER BY updated_at DESC"
  const rows = db.prepare(sql).all() as unknown as Row[]
  const products = rows.map(rowToProduct)
  const TIER_COUNT = 8

  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ')
    return `"${s.replace(/"/g, '""')}"`
  }

  const header = [
    'Product Title',
    'Summary Description',
    'Full Description',
    'Keywords',
    'Category',
    'Categories',
    'Themes',
    'Materials',
    'Colors',
    'Imprint Method',
    'Imprint Area',
    'Production Time',
    'Product Size (inch)',
    'Product Size (cm)',
    'Unit Weight (lb)',
    'Carton Size (inch)',
    'Carton Gross Weight (lb)',
    'Pcs / Carton',
    'Packaging',
    ...Array.from({ length: TIER_COUNT }, (_, i) => [`Tier${i + 1} Qty`, `Tier${i + 1} Price (USD)`]).flat(),
    'Title (ZH)',
    'Summary (ZH)',
    'Description (ZH)',
    'Keywords (ZH)',
    'Source URL',
    '1688 Price (CNY)',
    'MOQ',
    'Carton (cm)',
    '1688 Material',
    '1688 Colors',
    'Notes',
    'Status',
  ]

  const lines = [header.map(escape).join(',')]
  for (const p of products) {
    const l = p.listing
    const grid = l?.priceGrid ?? buildPriceGrid(p.source, loadSettings()).rows
    const cartonCm =
      [p.source.cartonLCm, p.source.cartonWCm, p.source.cartonHCm].filter(Boolean).join('x') +
      ' cm'
    const productSizeCm =
      (l?.productSizeCm && [l.productSizeCm.l, l.productSizeCm.w, l.productSizeCm.h].every(Boolean))
        ? `${l.productSizeCm.l}x${l.productSizeCm.w}x${l.productSizeCm.h} cm`
        : (p.source.sizeCn || '')
    const materials = l?.materials?.length ? l.materials.join(', ') : (l?.material ?? '')
    const colorsCsv = l?.colors ? l.colors.replace(/\//g, ', ') : ''
    lines.push(
      [
        l?.title ?? p.source.sourceTitle,
        l?.summary ?? '',
        l?.description ?? '',
        (l?.keywords ?? []).join(', '),
        l?.category ?? p.source.category,
        (l?.categories ?? [l?.category ?? p.source.category].filter(Boolean)).slice(0, 2).join(', '),
        (l?.themes ?? []).join(', '),
        materials,
        colorsCsv,
        (l?.imprintMethods ?? []).join('/'),
        l?.imprintArea ?? '',
        l?.productionTime ?? '',
        l?.productSizeInch ?? '',
        productSizeCm,
        l?.unitWeightLb ?? '',
        l?.cartonSizeInch ?? '',
        l?.cartonGwLb ?? '',
        p.source.pcsPerCarton ?? '',
        l?.packaging ?? '',
        ...Array.from({ length: TIER_COUNT }, (_, i) => {
          const hit = grid[i]
          return hit ? [hit.qty, hit.unitPrice.toFixed(2)] : ['', '']
        }).flat(),
        l?.titleZh ?? '',
        l?.summaryZh ?? '',
        l?.descriptionZh ?? '',
        l?.keywordsZh ?? '',
        p.source.sourceUrl,
        p.source.priceCny,
        p.source.moq,
        cartonCm,
        p.source.materialCn,
        p.source.colorsCn,
        p.source.notes,
        p.status,
      ]
        .map(escape)
        .join(',')
    )
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="asi-listings.csv"')
  res.send('\uFEFF' + lines.join('\n'))
})

// ---------- 导出供应商提交表（xlsx，最右列为 cm 录入 + 公式自动换算英寸/磅） ----------
productsRouter.get('/export/submission.xlsx', async (req: Request, res: Response) => {
  const includeTrashed = req.query.include_trashed === '1' || req.query.include_trashed === 'true'
  const sql = includeTrashed
    ? 'SELECT * FROM products ORDER BY updated_at DESC'
    : "SELECT * FROM products WHERE status != 'trashed' ORDER BY updated_at DESC"
  const rows = db.prepare(sql).all() as unknown as Row[]
  const products = rows.map(rowToProduct)
  const settings = loadSettings()

  // 严格匹配 gls产品表格1014.xlsx「上传产品-1」结构（表头一字不改 + cm 录入列 + 公式换算）
  const wb = buildGlsWorkbook({
    products,
    settings,
    numberPrefix: (req.query.prefix as string) || 'GLS',
  })

  const buf = await wb.xlsx.writeBuffer()
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  res.setHeader('Content-Disposition', 'attachment; filename="gls-upload.xlsx"')
  res.send(Buffer.from(buf))
})

// ---------- 预览（不落库） ----------

/**
 * 前端可以把「看图找类似 / 产品信息预填」已经算出来的英文搜索词带上来，
 * 后端就不用再让 AI 翻译一遍（少一次往返，也避开了中文品名翻不出英文的老问题）。
 */
function parseSearchTerms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((s) => String(s ?? '').trim())
    .filter((s) => s.length > 2)
    .slice(0, 5)
}

/** 从产品已存的“类似商品调研”里取英文搜索词：分销商目录优先，其次亚马逊词 */
function searchTermsFromSimilar(similar: unknown): string[] {
  if (!similar || typeof similar !== 'object') return []
  const s = similar as Record<string, unknown>
  const pick = (k: string) => (Array.isArray(s[k]) ? (s[k] as unknown[]).map((v) => String(v ?? '').trim()) : [])
  return [...pick('asiSearchTerms'), ...pick('amazonSearchTerms')]
    .filter((v) => v.length > 2)
    .slice(0, 5)
}

productsRouter.post('/preview/evaluate', async (req: Request, res: Response) => {
  const source = toSourceInfo(sourceSchema.parse(req.body?.source ?? {}))
  const settings = loadSettings()
  const searchTerms = parseSearchTerms((req.body as Record<string, unknown>)?.searchTerms)
  const productType = String((req.body as Record<string, unknown>)?.productType ?? '').trim().slice(0, 80)
  const evaluation = await runAi(() => evaluateSource(source, settings, { searchTerms, productType }))
  const { rows } = buildPriceGrid(source, settings)
  res.json({ evaluation, priceGrid: rows })
})

productsRouter.post('/preview/listing', async (req: Request, res: Response) => {
  const body = z
    .object({
      source: sourceSchema,
      answers: z
        .array(
          z.object({
            id: z.string(),
            question: z.string(),
            answer: z.string(),
          })
        )
        .optional(),
      similar: z.any().nullable().optional(),
      /** 选品评估结果：把结论与改善建议喂给 listing，保证文案方向和评估一致 */
      evaluation: z.any().nullable().optional(),
    })
    .parse(req.body ?? {})
  const source = toSourceInfo(body.source)
  const settings = loadSettings()
  const listing = await runAi(() =>
    generateListing(
      source,
      settings,
      body.answers as ListingAnswer[] | undefined,
      (body.similar ?? null) as SimilarResearch | null,
      (body.evaluation ?? null) as Evaluation | null
    )
  )
  res.json({ listing })
})

/** 生成前询问用户关键问题（产品特点 / 卖点 / 包装 / 印刷偏好等） */
productsRouter.post('/preview/listing-questions', async (req: Request, res: Response) => {
  const body = z
    .object({
      source: sourceSchema,
    })
    .parse(req.body ?? {})
  const source = toSourceInfo(body.source)
  const settings = loadSettings()
  try {
    const questions = await runAi(() => generateListingQuestions(source, settings))
    res.json({ questions })
  } catch (err) {
    if (err instanceof AiError) {
      // AI 故障时给兜底问题
      res.json({ questions: [], fallback: true, message: err.hint ?? err.message })
      return
    }
    throw err
  }
})

/** 看图找类似商品（基于已上传图片 + 1688 描述） */
productsRouter.post('/preview/find-similar', async (req: Request, res: Response) => {
  const source = toSourceInfo(sourceSchema.parse(req.body?.source ?? {}))
  const settings = loadSettings()
  const { system, user } = buildFindSimilarPrompt(source)
  const images = (source.images ?? []).slice(0, 4)
  const result = await runAi(() => callChatJson<Record<string, unknown>>(settings, system, user, 0.4, images))
  res.json({ similar: result })
})

/** 抓取提取出的商品资料（抓到多少算多少，缺失字段为空值） */
export interface GrabbedFetched {
  sourceTitle: string
  sourceKeywords: string[]
  description: string
  materialCn: string
  colorsCn: string
  sizeCn: string
  weightG: number | null
  cartonSpecCm: string
  pcsPerCarton: number | null
  cartonGwKg: number | null
  moq: number | null
  priceCny: number | null
  /** 首张产品图（尽力提取，可能为空） */
  image: string
  /** 产品图列表（最多 8 张，出图时作为多角度参考图；抓不到就是空数组） */
  images: string[]
}

/** 从页面 HTML 里捞产品大图（1688 的图基本都在 alicdn；排掉 logo/图标/二维码等噪声） */
export function extractImages(html: string, first?: string): string[] {
  const out: string[] = []
  const keyOf = (u: string) =>
    u
      .replace(/\.(jpg|jpeg|png|webp)(\?.*)?$/i, '')
      .replace(/_\d+x\d+[^/]*$/, '')
      .toLowerCase()
  const push = (raw: string) => {
    const u = raw.replace(/\\/g, '').trim()
    if (!/^https?:\/\//i.test(u)) return
    if (/logo|icon|sprite|avatar|qrcode|qr-|loading|placeholder|\.gif($|\?)/i.test(u)) return
    if (u.length > 400) return
    if (out.some((o) => keyOf(o) === keyOf(u))) return
    // 最多 12 张：1688 一个链接常按颜色/角度有十几张，全留下才能覆盖「所有颜色」
    if (out.length < 12) out.push(u)
  }
  if (first) push(first)
  for (const m of html.matchAll(/https?:\/\/[^"'\s\\)<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s\\)<>]*)?/gi)) {
    push(m[0])
    if (out.length >= 12) break
  }
  return out
}

/** 产品资料库记录 → 抓取结果（命中资料库时直接返回，不再打 1688） */
function masterToFetched(m: MasterProduct): GrabbedFetched {
  const carton = [m.cartonLCm, m.cartonWCm, m.cartonHCm]
  const hasCarton = carton.every((n) => typeof n === 'number' && n > 0)
  return {
    sourceTitle: m.title,
    sourceKeywords: [],
    description: m.notes,
    materialCn: m.materialCn,
    colorsCn: m.colorsCn,
    sizeCn: m.sizeCn,
    weightG: m.weightG,
    cartonSpecCm: hasCarton ? `${carton[0]}x${carton[1]}x${carton[2]}` : '',
    pcsPerCarton: m.pcsPerCarton,
    cartonGwKg: m.cartonGwKg,
    moq: null,
    priceCny: m.priceCny,
    image: m.images[0] ?? '',
    images: m.images,
  }
}

/** 统计抓到几项有效资料 */
function countFound(g: GrabbedFetched): number {  return [
    g.sourceTitle,
    g.sourceKeywords.join(''),
    g.description,
    g.materialCn,
    g.colorsCn,
    g.sizeCn,
    g.weightG != null ? '1' : '',
    g.cartonSpecCm,
    g.pcsPerCarton != null ? '1' : '',
    g.cartonGwKg != null ? '1' : '',
    g.priceCny != null ? '1' : '',
  ].filter(Boolean).length
}

/** 通道②：r.jina.ai 免费渲染抓取（海外渲染集群 + 页面缓存，可绕过 1688 对服务器 IP 的反爬）；失败返回 null */
async function grabViaJina(url: string): Promise<GrabbedFetched | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const r = await fetch('https://r.jina.ai/' + url, {
      signal: ctrl.signal,
      headers: { 'X-Return-Format': 'text' },
    })
    if (!r.ok) return null
    const text = await r.text()
    if (!text || text.length < 300) return null
    const num = (s: string) => Number(s.replace(/[^\d.]/g, ''))
    const specHit = (labelRe: RegExp, valRe: RegExp): string => {
      // 排除引号/花括号：jina 渲染文本可能混入页面 JSON 片段（如 材质","value":""），防止误当规格值
      const m = text.match(new RegExp(labelRe.source + String.raw`[^<>"']{0,80}?` + valRe.source, 'i'))
      return m
        ? m[0]
            .replace(/<[^>]+>/g, ' ')
            .replace(/["'{}\\]/g, ' ')
            .replace(/\|/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        : ''
    }
    const title = (text.match(/^Title:\s*(.+)$/m)?.[1] ?? '').replace(/[-–—|｜]\s*1688\.com.*$/i, '').trim()
    const body = text
      .replace(/^Title:.*$/m, '')
      .replace(/^URL Source:.*$/m, '')
      .replace(/^Markdown Content:\s*/m, '')
      .replace(/\s+/g, ' ')
      .trim()
    const material = specHit(/材\s*质/, /[\u4e00-\u9fa5A-Za-z0-9+、\/]{2,20}/)
    const colors = specHit(/颜\s*色/, /[\u4e00-\u9fa5A-Za-z、,，\/]{2,40}/)
    const size = specHit(/尺\s*寸/, /[\d.]+\s*[xX×*]\s*[\d.]+(cm|毫米|mm)?[^<>|]{0,20}/)
    const weight = specHit(/(单件)?重\s*量|单重/, /\d+(?:\.\d+)?\s*(g|克|kg|千克)/)
    const cartonSpec = specHit(/箱规|装箱尺寸|外箱尺寸/, /\d+(?:\.\d+)?\s*[xX×*]\s*\d+(?:\.\d+)?\s*[xX×*]\s*\d+(?:\.\d+)?/)
    const pcsPerCarton = specHit(/(每箱|装箱)数量|装箱数/, /\d+/)
    const cartonGw = specHit(/(整箱|箱)毛重|毛重/, /\d+(?:\.\d+)?\s*(kg|千克|kg\/箱)?/)
    const moq = specHit(/起批|起订|最少/, /\d+/)
    const priceM = text.match(/[¥￥]\s*(\d{1,5}(?:\.\d{1,2})?)/)
    const priceNum = priceM ? Number(priceM[1]) : null
    const priceCny = priceNum != null && priceNum >= 0.1 && priceNum <= 10000 ? priceNum : null
    // 首张产品图（jina markdown 中的图片，尽力提取）
    const image = text.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)?.[1] ?? ''
    const info: GrabbedFetched = {
      sourceTitle: title,
      sourceKeywords: [],
      description: body.slice(0, 1200),
      materialCn: material,
      colorsCn: colors,
      sizeCn: size,
      weightG: /kg|千克/i.test(weight) && !/克(?!千克)/.test(weight) ? Math.round(num(weight) * 1000) : weight ? Math.round(num(weight)) : null,
      cartonSpecCm: cartonSpec,
      pcsPerCarton: pcsPerCarton ? Math.round(num(pcsPerCarton)) : null,
      cartonGwKg: cartonGw ? Math.round(num(cartonGw) * 100) / 100 : null,
      moq: moq ? Math.round(num(moq)) : null,
      priceCny,
      image,
      images: (() => {
        const urls = Array.from(text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)).map((m) => m[1])
        return Array.from(new Set([image, ...urls].filter(Boolean))).slice(0, 8)
      })(),
    }
    return info.sourceTitle || info.description ? info : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 抓取单个 1688 页面并提取资料；网络/HTTP 失败返回 null（由上层重试其他候选链接） */
async function grab1688Once(url: string): Promise<GrabbedFetched | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12000)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://www.1688.com/',
        'Upgrade-Insecure-Requests': '1',
      },
    })
    if (!r.ok) return null
    const html = await r.text()
    const pick = (re: RegExp): string => {
      const m = html.match(re)
      return m ? decodeEntities(m[1]).trim() : ''
    }
    const title =
      pick(/<title>([^<]+)<\/title>/i).replace(/[-–—|｜]\s*1688\.com.*$/i, '') ||
      pick(/og:title["']\s*content=["']([^"']+)["']/i)
    const keywords = pick(/name=["']keywords["'][^>]*content=["']([^"']+)["']/i)
    const desc =
      pick(/name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
      pick(/og:description["']\s*content=["']([^"']+)["']/i)

    // 规格参数尽力提取（正则扫原始 HTML，命中即返回）
    const num = (s: string) => Number(s.replace(/[^\d.]/g, ''))
    const specHit = (labelRe: RegExp, valRe: RegExp): string => {
      const m = html.match(new RegExp(labelRe.source + String.raw`[^<>]{0,80}?` + valRe.source, 'i'))
      return m ? m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
    }
    const material = specHit(/材\s*质/, /[\u4e00-\u9fa5A-Za-z0-9+、\/]{2,20}/)
    const colors = specHit(/颜\s*色/, /[\u4e00-\u9fa5A-Za-z、,，\/]{2,40}/)
    const size = specHit(/尺\s*寸/, /[\d.]+\s*[xX×*]\s*[\d.]+(cm|毫米|mm)?[^<>]{0,20}/)
    const weight = specHit(/(单件)?重\s*量|单重/, /\d+(?:\.\d+)?\s*(g|克|kg|千克)/)
    const cartonSpec = specHit(/箱规|装箱尺寸|外箱尺寸/, /\d+(?:\.\d+)?\s*[xX×*]\s*\d+(?:\.\d+)?\s*[xX×*]\s*\d+(?:\.\d+)?/)
    const pcsPerCarton = specHit(/(每箱|装箱)数量|装箱数/, /\d+/)
    const cartonGw = specHit(/(整箱|箱)毛重|毛重/, /\d+(?:\.\d+)?\s*(kg|千克|kg\/箱)?/)
    const moq = specHit(/起批|起订|最少/, /\d+/)
    // 尽力提取页面价格（¥xx / "price":"x.xx"），仅供快速评估参考，可能不准
    const priceM = html.match(/[¥￥]\s*(\d{1,5}(?:\.\d{1,2})?)/) ?? html.match(/"price"\s*:\s*"?(\d{1,5}(?:\.\d{1,2})?)"?/)
    const priceNum = priceM ? Number(priceM[1]) : null
    const priceCny = priceNum != null && priceNum >= 0.1 && priceNum <= 10000 ? priceNum : null
    // 首张产品图（og:image，尽力提取）
    const image = pick(/og:image["']\s*content=["']([^"']+)["']/i)
    // 多张产品图：1688 的图基本都在 alicdn，排除 logo/图标/二维码等噪声后去重
    const images = extractImages(html, image)

    return {
      sourceTitle: title,
      sourceKeywords: keywords ? keywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
      description: desc,
      materialCn: material,
      colorsCn: colors,
      sizeCn: size,
      weightG: /kg|千克/i.test(weight) && !/克(?!千克)/.test(weight) ? Math.round(num(weight) * 1000) : weight ? Math.round(num(weight)) : null,
      cartonSpecCm: cartonSpec,
      pcsPerCarton: pcsPerCarton ? Math.round(num(pcsPerCarton)) : null,
      cartonGwKg: cartonGw ? Math.round(num(cartonGw) * 100) / 100 : null,
      moq: moq ? Math.round(num(moq)) : null,
      priceCny,
      image,
      images,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从 1688 抓取产品资料（标题 / 关键词 / 描述 / 规格参数尽力提取）。
 * 1688 反爬严格（海外服务器 IP 几乎必被拦），多通道兜底：
 * ① 并行直连（原链接 / 纯净桌面版 / 移动端）→ ② r.jina.ai 渲染抓取（海外渲染集群绕反爬）。
 */
export async function fetch1688Page(url: string): Promise<{ ok: boolean; found: number; message: string; fetched: GrabbedFetched; fromMaster?: boolean }> {
  if (!/^https?:\/\/[^/]*\.?1688\.com\//i.test(url)) {
    throw new AppError(400, '请输入 1688 商品链接（如 https://detail.1688.com/offer/xxx.html）')
  }

  // ⓪ 先查产品资料库：人工录入并核对过的资料，比反爬抓回来的可信，
  //    命中就不用再打 1688（也顺便解决箱规抓不到的问题）
  const master = findMasterByUrl(url)
  if (master) {
    const fetched = masterToFetched(master)
    return {
      ok: true,
      found: countFound(fetched),
      fetched,
      fromMaster: true,
      message: '资料来自「产品资料库」（你之前录过，直接复用，不再重复抓取）',
    }
  }

  const offerId = url.match(/offer\/(\d+)/)?.[1] ?? ''
  const clean = offerId ? `https://detail.1688.com/offer/${offerId}.html` : url
  const mobile = offerId ? `https://m.1688.com/offer/${offerId}.html` : url

  let best: GrabbedFetched | null = null
  let bestFound = 0

  // 通道①：并行直连三个候选（取命中字段最多的一份）
  const direct = await Promise.allSettled([grab1688Once(url), grab1688Once(clean), grab1688Once(mobile)])
  for (const it of direct) {
    if (it.status !== 'fulfilled' || !it.value) continue
    const found = countFound(it.value)
    if (found > bestFound) {
      best = it.value
      bestFound = found
    }
  }

  // 通道②：jina 渲染抓取（桌面版 + 移动版，绕过对服务器 IP 的反爬）
  if (bestFound === 0) {
    for (const u of [clean, mobile]) {
      const g = await grabViaJina(u)
      if (!g) continue
      const found = countFound(g)
      if (found > bestFound) {
        best = g
        bestFound = found
      }
      if (bestFound > 0) break
    }
  }

  if (bestFound > 0) {
    return {
      ok: true,
      found: bestFound,
      fetched: best!,
      message: `抓到 ${bestFound} 项资料，请核对后补充缺失字段（箱规等建议用「问商家话术」向客服确认）`,
    }
  }
  throw new AppError(
    502,
    '1688 反爬拦截了服务器抓取（海外 IP 属正常现象），已尝试直连与渲染抓取多通道仍未成功。请稍后重试；或到「产品信息预填」手动填写商品资料后正式评估'
  )
}

/**
 * 需求 8：从 1688 链接自动抓取产品资料（标题 / 关键词 / 描述 / 规格参数尽力提取）。
 */
productsRouter.post('/preview/fetch-1688', async (req: Request, res: Response) => {
  const url = String((req.body as Record<string, unknown>)?.url ?? '').trim()
  const { ok, fetched, message, fromMaster } = await fetch1688Page(url)
  res.json({ ok, fetched, message, fromMaster: Boolean(fromMaster) })
})

/**
 * 只抓图：给「链接生成 → 生成产品图」用。产品资料库里有图就用库里的（人工挑过的更准），
 * 没有才去 1688 页面捞多张图。
 */
productsRouter.post('/preview/fetch-1688-images', async (req: Request, res: Response) => {
  const url = String((req.body as Record<string, unknown>)?.url ?? '').trim()
  if (!/^https?:\/\/[^/]*\.?1688\.com\//i.test(url)) {
    throw new AppError(400, '请输入 1688 商品链接')
  }
  const master = findMasterByUrl(url)
  if (master?.images?.length) {
    res.json({ ok: true, images: master.images, source: 'master' })
    return
  }
  const offerId = url.match(/offer\/(\d+)/)?.[1] ?? ''
  const clean = offerId ? `https://detail.1688.com/offer/${offerId}.html` : url
  const merged: string[] = []
  for (const u of [clean, `https://m.1688.com/offer/${offerId}.html`]) {
    if (!offerId) break
    try {
      const g = await grab1688Once(u)
      for (const img of g?.images ?? []) {
        if (!merged.includes(img) && merged.length < 8) merged.push(img)
      }
    } catch {
      /* 单通道失败继续下一个 */
    }
    if (merged.length >= 4) break
  }
  res.json({
    ok: merged.length > 0,
    images: merged,
    source: 'scrape',
    message: merged.length ? `抓到 ${merged.length} 张图` : '没抓到图（1688 反爬或页面无图），请手动粘贴图片地址',
  })
})

/**
 * 链接快速评估：粘贴 1688 链接 → 自动抓取商品资料（多通道反爬兜底）→ 直接 AI 评估（评分 + 结论 + 建议）。
 * 供选品预估页「快速评估」使用；抓到多少算多少，缺的字段由产品信息预填页补充。
 */
productsRouter.post('/preview/quick-evaluate', async (req: Request, res: Response) => {
  const url = String((req.body as Record<string, unknown>)?.url ?? '').trim()
  const grabbed = await fetch1688Page(url)
  if (!grabbed.ok) {
    throw new AppError(502, `${grabbed.message}（快速评估需要至少抓到标题或描述，请稍后重试）`)
  }
  const f = grabbed.fetched
  // 箱规 "LxWxH" → 长/宽/高（厘米）
  const carton = f.cartonSpecCm.match(/(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)/)
  const source = toSourceInfo(
    sourceSchema.parse({
      sourceUrl: url,
      sourceTitle: f.sourceTitle,
      sourceKeywords: f.sourceKeywords,
      description: f.description,
      materialCn: f.materialCn,
      colorsCn: f.colorsCn,
      sizeCn: f.sizeCn,
      weightG: f.weightG ?? undefined,
      cartonLCm: carton ? Number(carton[1]) : undefined,
      cartonWCm: carton ? Number(carton[2]) : undefined,
      cartonHCm: carton ? Number(carton[3]) : undefined,
      pcsPerCarton: f.pcsPerCarton ?? undefined,
      cartonGwKg: f.cartonGwKg ?? undefined,
      moq: f.moq ?? undefined,
      priceCny: f.priceCny ?? undefined,
      // 产品图一并带上：评估时可以看图直接认品类，英文搜索词质量比纯文本翻译高
      images: f.images?.length ? f.images.slice(0, 3) : f.image ? [f.image] : undefined,
    })
  )
  const settings = loadSettings()
  const searchTerms = parseSearchTerms((req.body as Record<string, unknown>)?.searchTerms)
  const evaluation = await runAi(() => evaluateSource(source, settings, { searchTerms }))
  const { rows } = buildPriceGrid(source, settings)
  // 自动记录到「历史选品」（按链接去重，重复评估同一链接会覆盖更新）
  try {
    saveSourcingHistory({
      url,
      title: f.sourceTitle,
      score: evaluation.score,
      verdict: evaluation.verdict ?? null,
      source,
      fetched: f,
      evaluation,
      priceGrid: rows,
    })
  } catch {
    // 历史记录失败不影响评估结果返回
  }
  res.json({ ok: true, fetched: f, source, evaluation, priceGrid: rows, message: grabbed.message })
})

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
}

/** 统一的产品行更新（PATCH / 草稿同步 / 同草稿重复保存 共用） */
function updateProductRow(
  id: string,
  source: SourceInfo,
  evaluation: Evaluation | null,
  listing: Listing | null,
  status: string,
  now: string,
  similar?: SimilarResearch | null
): void {
  db.prepare(
    `UPDATE products SET source_title=?, source_url=?, description=?, source_keywords=?, amazon_title=?,
      price_cny=?, price_max_cny=?, moq=?, supplier=?, alt_suppliers=?, material_cn=?, colors_cn=?, size_cn=?, weight_g=?,
      carton_l_cm=?, carton_w_cm=?, carton_h_cm=?, pcs_per_carton=?, carton_gw_kg=?,
      images=?, category=?, notes=?, score=?, verdict=?, evaluation=?, listing=?, listing_title=?, status=?, updated_at=? WHERE id=?`
  ).run(
    source.sourceTitle,
    source.sourceUrl,
    source.description,
    JSON.stringify(source.sourceKeywords ?? []),
    source.amazonTitle,
    source.priceCny ?? null,
    source.priceMaxCny ?? null,
    source.moq ?? null,
    source.supplier,
    source.altSuppliers ?? '',
    source.materialCn,
    source.colorsCn,
    source.sizeCn,
    source.weightG ?? null,
    source.cartonLCm ?? null,
    source.cartonWCm ?? null,
    source.cartonHCm ?? null,
    source.pcsPerCarton ?? null,
    source.cartonGwKg ?? null,
    JSON.stringify(source.images ?? []),
    source.category,
    source.notes,
    evaluation?.score ?? null,
    evaluation?.verdict ?? null,
    evaluation ? JSON.stringify(evaluation) : null,
    listing ? JSON.stringify(listing) : null,
    listing?.title ?? '',
    status,
    now,
    id
  )
  // 市场调研结果（看图找类似）只在显式传入时覆盖，避免同步流程意外清空
  if (similar !== undefined) {
    // 该列迁移时为 TEXT NOT NULL DEFAULT '{}'，写 null 会触发 NOT NULL constraint failed（500）
    db.prepare('UPDATE products SET similar=? WHERE id=?').run(
      similar ? JSON.stringify(similar) : '{}',
      id
    )
  }
}

/**
 * 评估库草稿更新 → 同步 source/evaluation 到关联产品（draft_id）。
 * 供 drafts 模块在保存草稿时调用：评估库改数据，产品库同步更新。
 */
export function syncProductFromDraft(
  draftId: string,
  content: Record<string, unknown>
): Product | null {
  const linked = db
    .prepare('SELECT id FROM products WHERE draft_id = ?')
    .get(draftId) as { id: string } | undefined
  if (!linked) return null
  const current = findProduct(linked.id)
  const c = content as { source?: Partial<SourceInfo>; evaluation?: Evaluation | null }
  if (!c.source) return current
  const source = toSourceInfo({ ...current.source, ...c.source } as SourceInput)
  const evaluation = c.evaluation === undefined ? current.evaluation : (c.evaluation ?? null)
  updateProductRow(
    linked.id,
    source,
    evaluation,
    current.listing,
    current.status,
    new Date().toISOString()
  )
  return findProduct(linked.id)
}

// ---------- 创建（带 draftId 且已存在关联产品时改为更新，避免重复建品） ----------
productsRouter.post('/', async (req: Request, res: Response) => {
  const body = createSchema.parse(req.body ?? {})
  const now = new Date().toISOString()
  const evaluation = (body.evaluation ?? null) as Evaluation | null
  const listing = (body.listing ?? null) as Listing | null
  const similar = body.similar === undefined ? undefined : ((body.similar ?? null) as SimilarResearch | null)
  const s = toSourceInfo(body.source)

  // 同一评估草稿重复保存 → 直接更新已关联的产品（评估库 ↔ 产品库 同步）
  if (body.draftId) {
    const linked = db
      .prepare('SELECT id FROM products WHERE draft_id = ?')
      .get(body.draftId) as { id: string } | undefined
    if (linked) {
      const existingRow = db.prepare('SELECT status FROM products WHERE id = ?').get(linked.id) as
        | { status: string }
        | undefined
      updateProductRow(
        linked.id,
        s,
        evaluation,
        listing,
        body.status ?? existingRow?.status ?? 'sourced',
        now,
        similar
      )
      res.json({ product: findProduct(linked.id), updated: true })
      return
    }
  }

  const id = insertProduct({
    source: s,
    evaluation,
    listing,
    similar,
    status: body.status,
    draftId: body.draftId,
    now,
  })
  res.status(201).json({ product: findProduct(id) })
})

/** 现有最大产品编号数字（RPA0007 → 7）；没有则 0 */
function maxCodeNumber(): number {
  try {
    const row = db
      .prepare("SELECT code FROM products WHERE code LIKE 'PIP%' ORDER BY code DESC LIMIT 1")
      .get() as { code: string } | undefined
    if (!row?.code) return 0
    const n = Number.parseInt(row.code.replace(/^PIP/i, ''), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/**
 * 流水线临时编号：PIP0001、PIP0002…
 * 产品第一次进「预产品库」时会换成 GLS0001…（见 services/numbering.ts），进 RPA 档案库再换人工号。
 * 所以这里的 PIP 号只是流水线期间用来认产品的临时号，不对外。
 */
function nextProductCode(): string {
  return `PIP${String(maxCodeNumber() + 1).padStart(4, '0')}`
}

/**
 * 把生成的英文 listing 写回「同一条产品档案」。
 *
 * 统一档案的关键：生成链接不再另建一条产品，而是把档案本身推到「待审核」，
 * 审核通过再把同一条改成正式产品。这样编号、资料、评估、文案、图片始终在一行上。
 */
export function applyListingToExistingProduct(
  id: string,
  input: { source: SourceInfo; evaluation: Evaluation | null; listing: Listing; status: ProductStatus }
): void {
  const now = new Date().toISOString()
  updateProductRow(id, input.source, input.evaluation, input.listing, input.status, now)
  db.prepare("UPDATE products SET review_state='pending', review_note='', updated_at=? WHERE id=?").run(now, id)
}

/**
 * 老数据补编号：列是新加的，历史产品 code 都是空串。
 * 按创建顺序补，编号顺序就等于产品实际录入顺序。
 */
export function backfillProductCodes(): number {
  try {
    const rows = db
      .prepare("SELECT id FROM products WHERE code IS NULL OR code = '' ORDER BY created_at ASC")
      .all() as unknown as Array<{ id: string }>
    if (!rows.length) return 0
    let n = maxCodeNumber()
    const stmt = db.prepare('UPDATE products SET code = ? WHERE id = ?')
    for (const r of rows) {
      n += 1
      stmt.run(`PIP${String(n).padStart(4, '0')}`, r.id)
    }
    return rows.length
  } catch (err) {
    console.warn('[products] 补产品编号失败（不影响使用）:', err instanceof Error ? err.message : err)
    return 0
  }
}

// 服务启动时补一次历史产品编号（列是新加的，老数据全空）
backfillProductCodes()

/**
 * 插入一条产品（单品「保存到产品库」与批量处理共用同一段 SQL，避免两边字段不一致）。
 * 行为与原先内联的 INSERT 完全一致，只是抽成函数供批量任务复用。
 */
export function insertProduct(input: {
  source: SourceInfo
  evaluation: Evaluation | null
  listing: Listing | null
  similar?: SimilarResearch | null
  status?: ProductStatus
  draftId?: string | null
  now?: string
}): string {
  const s = input.source
  const evaluation = input.evaluation
  const listing = input.listing
  const similar = input.similar
  const now = input.now ?? new Date().toISOString()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO products (id, code, draft_id, source_title, source_url, description, source_keywords, amazon_title,
      price_cny, price_max_cny, moq, supplier, alt_suppliers, material_cn, colors_cn, size_cn, weight_g,
      carton_l_cm, carton_w_cm, carton_h_cm, pcs_per_carton, carton_gw_kg,
      images, category, notes, score, verdict, evaluation, listing, listing_title, similar, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    nextProductCode(),
    input.draftId ?? null,
    s.sourceTitle,
    s.sourceUrl,
    s.description,
    JSON.stringify(s.sourceKeywords ?? []),
    s.amazonTitle,
    s.priceCny ?? null,
    s.priceMaxCny ?? null,
    s.moq ?? null,
    s.supplier,
    s.altSuppliers ?? '',
    s.materialCn,
    s.colorsCn,
    s.sizeCn,
    s.weightG ?? null,
    s.cartonLCm ?? null,
    s.cartonWCm ?? null,
    s.cartonHCm ?? null,
    s.pcsPerCarton ?? null,
    s.cartonGwKg ?? null,
    JSON.stringify(s.images ?? []),
    s.category,
    s.notes,
    evaluation?.score ?? null,
    evaluation?.verdict ?? null,
    evaluation ? JSON.stringify(evaluation) : null,
    listing ? JSON.stringify(listing) : null,
    listing?.title ?? '',
    // 该列迁移时为 TEXT NOT NULL DEFAULT '{}'，写 null 会触发 NOT NULL constraint failed（500）
    similar ? JSON.stringify(similar) : '{}',
    input.status ?? (listing ? 'listed' : 'sourced'),
    now,
    now
  )
  return id
}

// ---------- 单条读取 ----------
productsRouter.get('/:id', async (req: Request, res: Response) => {
  res.json({ product: findProduct(String(req.params.id)) })
})

// ---------- 更新 ----------
productsRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const force = (req.body as Record<string, unknown> | undefined)?.force
  assertEditable(id, force, '修改产品资料/文案')
  const current = findProduct(id)
  const patch = updateSchema.parse(req.body ?? {})

  const source: SourceInfo = toSourceInfo({ ...current.source, ...(patch.source ?? {}) })
  const evaluation =
    patch.evaluation === undefined ? current.evaluation : (patch.evaluation as Evaluation | null)
  // 手动编辑保存时同样强制 ASI 合规（必填印刷方式 / 主题 / 字符数 / QC）
  const listing =
    patch.listing === undefined
      ? current.listing
      : patch.listing
        ? applyQc(patch.listing as Listing)
        : null
  const status = patch.status ?? current.status

  // 待审核的档案在链接生成页核对后保存 = 人工确认通过 → 原地转正式产品。
  // 这一步就是「所有信息确认好后保存到产品库」，不需要再回待审核点一次通过。
  let nextStatus = status
  if (!patch.status && current.status === 'pending_review' && patch.listing) {
    nextStatus = 'listed'
  }
  const nowIso = new Date().toISOString()

  updateProductRow(id, source, evaluation, listing, nextStatus, nowIso)
  if (nextStatus === 'listed' && current.status === 'pending_review') {
    db.prepare(
      "UPDATE products SET review_state='approved', reviewed_at=? WHERE id=?"
    ).run(nowIso, id)
    // 批量任务靠 listing_reviews 记录判断这条审核结果，这里同步一下，避免批次里一直显示"待审核"
    db.prepare(
      "UPDATE listing_reviews SET status='approved', updated_at=? WHERE product_id=? AND status='pending'"
    ).run(nowIso, id)
  }
  res.json({ product: findProduct(id) })
})

// ---------- 更新源信息（链接生成页「源信息一览」编辑入口） ----------
// 系统一体化：改这里 → ① 产品库 source 更新 ② 评估库草稿 content.source 同步
//   ③ listing 派生字段联动重算（英制换算/价格表/包装文案/材质颜色标签）
productsRouter.patch('/:id/source', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const force = (req.body as Record<string, unknown> | undefined)?.force
  assertEditable(id, force, '修改产品资料')
  const current = findProduct(id)
  const patch = updateSchema.parse(req.body ?? {})
  if (!patch.source) throw new AppError(400, '缺少 source 字段')

  const source = toSourceInfo({ ...current.source, ...patch.source })
  const settings = settingsForProduct(current)

  // ① listing 派生字段联动重算（不改动 AI 生成的文案内容，只同步与源信息强相关的数据）
  let listing = current.listing
  const syncedFields: string[] = []
  const units = convertUnits(source)
  const rows = buildPriceGrid(source, settings).rows
  const derived = {
    productSizeInch: units.productSizeInch,
    productSizeCm: units.productSizeCm,
    unitWeightLb: units.unitWeightLb,
    cartonSizeInch: units.cartonSizeInch,
    cartonGwLb: units.cartonGwLb,
    priceGrid: rows,
  }
  if (listing) {
    listing = {
      ...listing,
      ...derived,
      packaging: units.cartonSizeInch
        ? `Carton: ${units.cartonSizeInch}, ${source.pcsPerCarton ?? '?'} pcs/ctn, ${units.cartonGwLb ?? '?'} lb`
        : listing.packaging,
    }
    if (current.source.weightG !== source.weightG) syncedFields.push('单件重量')

    /*
     * 材质变了 → 材质标签和印刷方式必须跟着变。
     * 印刷方式是**材质驱动**的（PVC 不能用热升华、深色涤纶会发灰……），
     * 所以这里直接用同一个规则引擎重算，而不是让业务员手动改。
     */
    const materialChanged = (current.source.materialCn ?? '') !== (source.materialCn ?? '')
    if (materialChanged) {
      try {
        const reco = recommendImprintMethods(source)
        if (reco.materialTags.length) {
          listing = {
            ...listing,
            materials: reco.materialTags,
            material: reco.materialTags.join(', '),
          }
        }
        const required = ['Silkscreen', 'Unimprinted', 'Full Color']
        const compatible = new Set(reco.recommendations.map((r) => r.method as string))
        const kept = (listing.imprintMethods ?? []).filter(
          (m) => required.includes(m) || compatible.has(m)
        )
        const picked = reco.recommendations
          .filter((r) => r.tier === 'primary' || r.tier === 'suitable')
          .slice(0, 4)
          .map((r) => r.method as string)
        listing = {
          ...listing,
          imprintMethods: Array.from(new Set([...required, ...kept, ...picked])),
        }
        syncedFields.push('材质', '印刷方式')
      } catch {
        // 规则引擎异常不影响保存
      }
    }

    /*
     * 颜色变了 → 文案里的颜色也要改（英文颜色名必须走译名，不能直接塞中文）。
     * 颜色是个小字段，用现成的字段重生管线最稳（失败就保留旧值，不阻塞保存）。
     */
    const colorsChanged = (current.source.colorsCn ?? '') !== (source.colorsCn ?? '')
    if (colorsChanged && (source.colorsCn ?? '').trim()) {
      try {
        const vals = await runAi(() =>
          regenerateListingFields(
            source,
            listing as Partial<Listing>,
            ['colors', 'colorChips'],
            undefined,
            settings,
            current.evaluation,
            current.similar
          )
        )
        listing = { ...(listing as Listing), ...(vals as Partial<Listing>) }
        syncedFields.push('颜色')
      } catch {
        // 颜色翻译失败：保留旧颜色，不阻塞保存
      }
    }
  }

  // ② 待审核版本（批量生成后停在「待审核」的产品）：派生数据要写进那条审核草稿，
  //    否则编辑页改了箱规/重量，价格表是旧的（产品自己的 listing 还是空的）。
  const reviewListing = syncStagedReviewListing(id, {
    ...derived,
    ...(units.cartonSizeInch
      ? { packaging: `Carton: ${units.cartonSizeInch}, ${source.pcsPerCarton ?? '?'} pcs/ctn, ${units.cartonGwLb ?? '?'} lb` }
      : {}),
  })
  if (reviewListing) syncedFields.push('待审核文案里的价格表')

  // ③ 更新产品库（source + 联动后的 listing）
  updateProductRow(id, source, current.evaluation, listing, current.status, new Date().toISOString())
  // ④ 反向同步资料库：同链接的那条记录一起更新，下次同款直接复用新数据
  const masterSynced = applyProductSourceToMaster(source)

  // ③ 同步评估库草稿（评估库 ↔ 产品库 双向一致）
  let syncedDraftId: string | null = null
  if (current.draftId) {
    try {
      const draftRow = db.prepare('SELECT content FROM drafts WHERE id = ?').get(current.draftId) as
        | { content: string }
        | undefined
      if (draftRow) {
        let content: Record<string, unknown> = {}
        try {
          content = JSON.parse(draftRow.content) as Record<string, unknown>
        } catch {
          content = {}
        }
        content.source = { ...(content.source as Record<string, unknown> | undefined), ...source }
        db.prepare('UPDATE drafts SET content = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(content),
          new Date().toISOString(),
          current.draftId
        )
        syncedDraftId = current.draftId
      }
    } catch {
      // 草稿同步失败不影响产品更新
    }
  }

  res.json({ product: findProduct(id), syncedDraftId, masterSynced, syncedFields, reviewListing })
})

// ---------- 软删：移到回收站（DELETE /:id） ----------
productsRouter.delete('/:id', async (req: Request, res: Response): Promise<Response> => {
  const id = String(req.params.id)
  const existing = db.prepare('SELECT status FROM products WHERE id = ?').get(id) as
    | { status: string }
    | undefined
  if (!existing) throw new AppError(404, '产品不存在')
  if (existing.status === 'trashed') {
    // 已在回收站：再次 DELETE 视为「永久删除」（避免误删需走 purge）
    db.prepare('DELETE FROM products WHERE id = ?').run(id)
    return res.json({ ok: true, action: 'purged', message: '回收站内产品已永久删除', id })
  }
  const now = new Date().toISOString()
  db.prepare("UPDATE products SET status='trashed', trashed_at=?, updated_at=? WHERE id=?").run(
    now,
    now,
    id
  )
  return res.json({ ok: true, action: 'trashed', message: '已移到回收站，可在回收站恢复或彻底删除', id })
})

// ---------- 恢复：回收站 → 重新回到 sourced ----------
productsRouter.post('/:id/restore', async (req: Request, res: Response): Promise<Response> => {
  const id = String(req.params.id)
  const existing = db.prepare('SELECT status FROM products WHERE id = ?').get(id) as
    | { status: string }
    | undefined
  if (!existing) throw new AppError(404, '产品不存在')
  if (existing.status !== 'trashed') {
    return res.json({ ok: true, message: '产品不在回收站，无需恢复', id })
  }
  const now = new Date().toISOString()
  db.prepare("UPDATE products SET status='sourced', trashed_at=NULL, updated_at=? WHERE id=?").run(
    now,
    id
  )
  return res.json({ ok: true, message: '已从回收站恢复', id, product: findProduct(id) })
})

// ---------- 永久删除 ----------
productsRouter.delete('/:id/purge', async (req: Request, res: Response) => {
  const info = db.prepare('DELETE FROM products WHERE id = ?').run(String(req.params.id))
  if (!info.changes) throw new AppError(404, '产品不存在')
  res.json({ ok: true, action: 'purged', message: '已永久删除', id: req.params.id })
})

// ---------- AI：选品评估（落库） ----------
productsRouter.post('/:id/evaluate', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  // 只刷新评估：不碰 listing（英文文案）。RPA 库产品同样要确认后带 force。
  assertEditable(id, (req.body as Record<string, unknown> | undefined)?.force, '刷新评估')
  const current = findProduct(id)
  const settings = settingsForProduct(current)
  // 优先用请求里带的词；没有就复用这个产品保存时存下的「类似商品调研」关键词（免费的，不用再调 AI）
  const fromBody = parseSearchTerms((req.body as Record<string, unknown>)?.searchTerms)
  const searchTerms = fromBody.length ? fromBody : searchTermsFromSimilar(current.similar)
  const evaluation = await runAi(() => evaluateSource(current.source, settings, { searchTerms }))
  db.prepare('UPDATE products SET score=?, verdict=?, evaluation=?, updated_at=? WHERE id=?').run(
    evaluation.score,
    evaluation.verdict,
    JSON.stringify(evaluation),
    new Date().toISOString(),
    id
  )
  // listing 一个字都没动：这里只写 score/verdict/evaluation 三列，
  // 已生成的英文文案（标题/摘要/描述/关键词/价格表）保持原样。
  res.json({ product: findProduct(id), evaluationOnly: true })
})

/** 多轮对话调整评估（不落库，给 Sourcing 评估区使用） */
productsRouter.post('/preview/chat-evaluation', async (req: Request, res: Response) => {
  const body = z
    .object({
      source: sourceSchema,
      evaluation: z.any(),
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant', 'system']),
            content: z.string(),
          })
        )
        .min(1),
    })
    .parse(req.body ?? {})
  const source = toSourceInfo(body.source)
  const settings = loadSettings()
  const currentEval = body.evaluation as Evaluation
  if (!currentEval || typeof currentEval.score !== 'number') {
    throw new AppError(400, '缺少当前评估结果，请先完成选品评估')
  }
  const { evaluation, assistantReply } = await runAi(() =>
    chatEvaluateSource(source, currentEval, body.messages as ChatMessage[], settings)
  )
  res.json({ evaluation, assistantReply })
})

// ---------- AI：多轮对话调整评估（落库） ----------
productsRouter.post('/:id/chat-evaluation', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const current = findProduct(id)
  if (!current.evaluation) {
    throw new AppError(400, '该产品还没有评估结果，请先点击「AI 选品评估」')
  }
  const body = z
    .object({
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant', 'system']),
            content: z.string(),
          })
        )
        .min(1),
    })
    .parse(req.body ?? {})
  const settings = loadSettings()
  const { evaluation } = await runAi(() =>
    chatEvaluateSource(current.source, current.evaluation as Evaluation, body.messages as ChatMessage[], settings)
  )
  db.prepare('UPDATE products SET score=?, verdict=?, evaluation=?, updated_at=? WHERE id=?').run(
    evaluation.score,
    evaluation.verdict,
    JSON.stringify(evaluation),
    new Date().toISOString(),
    id
  )
  // 同步评估库草稿：对话改了评估分，评估库那条也要跟着变（否则两处分数不一致）
  if (current.draftId) {
    try {
      const draftRow = db.prepare('SELECT content FROM drafts WHERE id = ?').get(current.draftId) as
        | { content: string }
        | undefined
      if (draftRow) {
        let content: Record<string, unknown> = {}
        try {
          content = JSON.parse(draftRow.content) as Record<string, unknown>
        } catch {
          content = {}
        }
        content.evaluation = evaluation
        content.score = evaluation.score
        db.prepare('UPDATE drafts SET content = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(content),
          new Date().toISOString(),
          current.draftId
        )
      }
    } catch {
      // 草稿同步失败不影响产品
    }
  }
  res.json({ product: findProduct(id) })
})

// ---------- AI：生成 Listing（异步任务模式：立即返回 taskId，后台执行，前端轮询） ----------
// Render 免费层代理有 100 秒硬超时，同步等待 AI 生成（1-5 分钟）必然 502。
// 改为：POST 立即返回 taskId → 后台跑 generateListing → 前端 GET /tasks/:taskId 轮询结果。
productsRouter.post('/:id/listing', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const current = findProduct(id)
  const settings = settingsForProduct(current)
  const body = z
    .object({
      answers: z
        .array(
          z.object({
            id: z.string(),
            question: z.string(),
            answer: z.string(),
          })
        )
        .optional(),
      /** 强制重做市场参考（默认只在还没有市场参考时自动补做，省一次识图调用） */
      refreshSimilar: z.boolean().optional(),
    })
    .parse(req.body ?? {})

  const task = createTask('generate-listing')
  runTask(task, async () => {
    // 生成英文文案前先补「看图找类似」：listing 里的标题用词、description 写法、30 组 keywords
    // 本来就靠这份 Amazon/ASI 市场参考；缺了 AI 只能自己编，编出来的词多半搜不到流量。
    // 只有完全没有市场参考（或用户显式要求刷新）时才跑识图，避免每次重生成都多花一次图片 token。
    let similar = current.similar
    if (body.refreshSimilar || !hasSimilarResearch(similar)) {
      updateTask(task.id, { progress: '正在看图找类似（Amazon / ASI 市场参考）…' })
      try {
        similar = await findSimilarForSource(current.source, settings)
        db.prepare('UPDATE products SET similar=?, updated_at=? WHERE id=?').run(
          JSON.stringify(similar),
          new Date().toISOString(),
          id
        )
      } catch {
        // 市场参考失败不能挡住文案生成：降级成「没有参考」，提示词少这一段而已
        similar = hasSimilarResearch(similar) ? similar : null
      }
    }
    updateTask(task.id, {
      progress: hasSimilarResearch(similar) ? '市场参考已就绪，正在生成英文链接…' : '正在生成英文链接…',
    })
    const listing = await runAi(() =>
      generateListing(current.source, settings, body.answers as ListingAnswer[] | undefined, similar, current.evaluation ?? null)
    )
    // 生成后先把档案推进「待审核」，**不直接当正式产品**：
    // 无论是单品页还是批量，没人工核对过的英文链接都不该直接进产品库。
    applyListingToExistingProduct(id, {
      source: current.source,
      evaluation: current.evaluation,
      listing,
      status: 'pending_review',
    })
    return { productId: id, similarReady: hasSimilarResearch(similar) }
  })

  res.json({ taskId: task.id, status: task.status })
})

// ---------- 任务轮询：查询异步任务状态/结果 ----------
productsRouter.get('/tasks/:taskId', (req: Request, res: Response) => {
  const task: TaskRecord | undefined = getTask(String(req.params.taskId))
  if (!task) {
    throw new AppError(404, '任务不存在或已过期（服务重启会清空任务，请重新生成）')
  }
  res.json(task)
})

// ---------- AI：分块重新生成（只重生成指定区块字段，不重生成整个 listing；不落库，由前端确认后保存） ----------
const REGEN_FIELD_ENUM = [
  'title',
  'summary',
  'description',
  'keywords',
  'category',
  'typeOfProduct',
  'categories',
  'themes',
  'material',
  'materials',
  'colors',
  'colorChips',
  'imprintMethods',
  'imprintArea',
  'productionTime',
  'packaging',
  'warnings',
  'titleZh',
  'summaryZh',
  'descriptionZh',
  'keywordsZh',
] as const

const regenFieldsSchema = z.object({
  fields: z.array(z.enum(REGEN_FIELD_ENUM)).min(1).max(8),
  instruction: z.string().max(2000).optional(),
})

productsRouter.post('/:id/regenerate-fields', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const current = findProduct(id)
  const body = regenFieldsSchema.parse(req.body ?? {})
  const settings = settingsForProduct(current)
  const values = await runAi(() =>
    regenerateListingFields(
      current.source,
      current.listing as Partial<Listing> | null,
      body.fields,
      body.instruction,
      settings,
      current.evaluation ?? null,
      current.similar
    )
  )
  // 与现有 listing 合并并重跑 QC（强制必填印刷方式/主题等），但不落库
  const merged = current.listing ? applyQc({ ...current.listing, ...values } as Listing) : null
  res.json({ values, listing: merged })
})

// ---------- AI：看图找类似商品（落库） ----------
productsRouter.post('/:id/find-similar', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const current = findProduct(id)
  const settings = settingsForProduct(current)
  const similar = await runAi(() => findSimilarForSource(current.source, settings))
  db.prepare('UPDATE products SET similar=?, updated_at=? WHERE id=?').run(
    JSON.stringify(similar),
    new Date().toISOString(),
    id
  )
  res.json({ similar, product: findProduct(id) })
})

/**
 * 把新的派生数据/价格表同步进「待审核」草稿。
 *
 * 为什么需要：批量生成的文案先停在审核库（products.listing 还是空的），编辑页显示的
 * 是这条审核草稿的 listing。改箱规 / 重算价格时如果只更新 products.listing，
 * 用户就会觉得「改了尺寸价格没变」——其实数据写到了另一个空档案上。
 */
function syncStagedReviewListing(productId: string, patch: Partial<Listing>): Partial<Listing> | null {
  try {
    const rev = db
      .prepare(
        "SELECT id, listing FROM listing_reviews WHERE product_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
      )
      .get(productId) as { id: string; listing: string } | undefined
    if (!rev) return null
    const cur = (() => {
      try {
        return JSON.parse(rev.listing || '{}') as Partial<Listing>
      } catch {
        return {} as Partial<Listing>
      }
    })()
    const merged = { ...cur, ...patch }
    db.prepare('UPDATE listing_reviews SET listing=?, price_grid=?, updated_at=? WHERE id=?').run(
      JSON.stringify(merged),
      JSON.stringify(merged.priceGrid ?? []),
      new Date().toISOString(),
      rev.id
    )
    return merged
  } catch {
    return null
  }
}

// ---------- 价格表重算 ----------
productsRouter.post('/:id/reprice', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const force = (req.body as Record<string, unknown> | undefined)?.force
  assertEditable(id, force, '重算价格')
  const current = findProduct(id)
  const settings = settingsForProduct(current)
  // 计费重 / 倍率允许人工指定：改了就用人工值重算整张阶梯表
  const body = z
    .object({
      billableKg: z.coerce.number().positive().nullable().optional(),
      markupAir: z.coerce.number().positive().nullable().optional(),
      markupSea: z.coerce.number().positive().nullable().optional(),
      /** 逐档空运/海运（null = 该档沿用自动分配） */
      shippingModes: z.array(z.enum(['air', 'sea']).nullable()).max(12).optional(),
      /** 只切换某一档：其它档一律不动，避免「点一个档整表价都变」 */
      toggle: z
        .object({
          idx: z.coerce.number().int().min(0).max(11),
          mode: z.enum(['air', 'sea']),
        })
        .optional(),
    })
    .parse(req.body ?? {})

  // 只切换某一档运输方式：就地改这一行，其它档一个字段都不动
  // （以前是把整表重新 buildPriceGrid 一遍，会把之前手动切过的档和人工改过的价格冲掉）
  if (body.toggle) {
    const currentRows = (current.listing?.priceGrid ?? []) as PriceRow[]
    if (!currentRows.length || body.toggle.idx >= currentRows.length) {
      throw new AppError(400, '这一档不存在，请刷新页面后重试')
    }
    const rows = retogglePriceRow({
      source: current.source,
      settings,
      rows: currentRows,
      idx: body.toggle.idx,
      mode: body.toggle.mode,
    })
    const listing: Listing | null = current.listing ? { ...current.listing, priceGrid: rows } : null
    if (listing) {
      db.prepare('UPDATE products SET listing=?, updated_at=? WHERE id=?').run(
        JSON.stringify(listing),
        new Date().toISOString(),
        id
      )
    }
    const reviewListing = syncStagedReviewListing(id, { priceGrid: rows })
    res.json({ priceGrid: rows, product: findProduct(id), reviewListing })
    return
  }

  // 整表重算时保留每一档原本的倍率（除非用户显式改了全局倍率）：
  // 否则「改了运费再重算」会把人工调过的 1.35 之类冲回默认 1.4，价格看起来乱跳。
  const prevRows = (current.listing?.priceGrid ?? []) as PriceRow[]
  const preserveMarkups =
    body.markupAir == null && body.markupSea == null && prevRows.length
      ? Object.fromEntries(prevRows.map((r, i) => [i, r.markupRate]).filter(([, v]) => typeof v === 'number'))
      : undefined

  const overrides: Parameters<typeof buildPriceGrid>[2] = {
    billableKg: body.billableKg,
    markupAir: body.markupAir,
    markupSea: body.markupSea,
    shippingModes: body.shippingModes,
    ...(preserveMarkups ? { markupByIndex: preserveMarkups as Record<number, number> } : {}),
  }

  const { rows } = buildPriceGrid(current.source, settings, overrides)
  const listing: Listing | null = current.listing
    ? { ...current.listing, priceGrid: rows }
    : null
  if (listing) {
    db.prepare('UPDATE products SET listing=?, updated_at=? WHERE id=?').run(
      JSON.stringify(listing),
      new Date().toISOString(),
      id
    )
  }
  const reviewListing = syncStagedReviewListing(id, { priceGrid: rows })
  res.json({ priceGrid: rows, product: findProduct(id), reviewListing })
})
// ---------- 单产品定价参数（汇率 / 空运海运价 / 印刷费 / 样品费 / 杂费 / 会员折扣） ----------
// 不同产品印刷处数、谈下来的运费都不一样，所以这些参数要能逐产品改，而不是改全局影响所有产品。
productsRouter.patch('/:id/price-settings', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const force = (req.body as Record<string, unknown> | undefined)?.force
  assertEditable(id, force, '修改定价参数')
  const current = findProduct(id)
  const body = z
    .object({
      fxRate: z.number().positive().optional(),
      airRateCnyPerKg: z.number().min(0).optional(),
      seaRateCnyPerKg: z.number().min(0).optional(),
      volumetricDivisor: z.number().min(100).optional(),
      markupAir: z.number().min(1).max(5).optional(),
      markupSea: z.number().min(1).max(5).optional(),
      printCostCny: z.number().min(0).optional(),
      sampleFeeCny: z.number().min(0).optional(),
      miscFeePct: z.number().min(0).max(50).optional(),
      espMemberDiscount: z.number().min(0.1).max(1).optional(),
      /** true = 清空覆盖，回到全局设置 */
      reset: z.boolean().optional(),
    })
    .parse(req.body ?? {})

  const next = body.reset ? null : { ...(current.priceSettings ?? {}) }
  if (next) {
    for (const k of PRICE_KEYS) {
      const v = (body as Record<string, unknown>)[k]
      if (typeof v === 'number' && Number.isFinite(v)) (next as Record<string, number>)[k] = v
    }
  }
  db.prepare('UPDATE products SET price_settings=?, updated_at=? WHERE id=?').run(
    next ? JSON.stringify(next) : null,
    new Date().toISOString(),
    id
  )

  // 改完立刻按新参数重算阶梯价（否则用户还要再点一次重算）
  const settings = settingsForProduct({ priceSettings: next as Record<string, unknown> | null })
  let listing = current.listing
  if (listing) {
    const { rows } = buildPriceGrid(current.source, settings)
    listing = { ...listing, priceGrid: rows }
    db.prepare('UPDATE products SET listing=?, updated_at=? WHERE id=?').run(
      JSON.stringify(listing),
      new Date().toISOString(),
      id
    )
  }
  res.json({ product: findProduct(id), priceSettings: next, effective: settings })
})
// ---------- 识图比价（单独跑：视觉调用慢，不能塞进评估主链路，否则整次评估会被 Cloudflare 判超时） ----------
productsRouter.post('/:id/visual-price-check', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const current = findProduct(id)
  const force = (req.body as Record<string, unknown> | undefined)?.force
  assertEditable(id, force, '识图比价')
  const settings = settingsForProduct(current)
  const ev = current.evaluation
  const ms = ev?.marketSnapshot
  const queries = (ms?.queries ?? []).filter(Boolean).slice(0, 2)
  if (!queries.length) throw new AppError(400, '这条评估还没有海外搜索词，请先重新评估一次')

  const form = formOfSource(current.source.sourceTitle, current.source.description)
  const diag = await probeWithDiag(queries, 9000, {
    coreKeywords: ms?.matchTokens ?? [],
    ...(form !== 'unknown' ? { productForm: form } : {}),
  })
  if (!diag.snapshot) throw new AppError(502, diag.error ?? '海外探针没取到数据')

  const raw = applyMemberDiscount(diag.snapshot, settings.espMemberDiscount ?? 0.6)
  const check = await buildVisualPriceCheck(
    settings,
    (current.source.images ?? []).slice(0, 2),
    `${current.source.sourceTitle}（${form}）`,
    raw
  )
  if (!check) throw new AppError(502, '识图比价失败（视觉模型没有返回结果）')

  // 合并进已有评估：只更新识图比价与建议报价，其它字段不动
  const nextEvaluation = ev
    ? {
        ...ev,
        marketSnapshot: {
          ...ms,
          priceCheck: {
            checked: check.checked,
            confirmedCount: check.confirmedCount,
            sameCount: check.sameCount,
            priceLow: check.price?.p25 ?? null,
            priceHigh: check.price?.p75 ?? null,
            median: check.price?.median ?? null,
            note: check.note,
            items: check.items.slice(0, 8).map((i) => ({
              title: i.title,
              priceMin: i.priceMin,
              source: i.source,
              url: i.url,
              same: i.same,
              confidence: i.confidence,
              ...(i.reason ? { reason: i.reason } : {}),
              ...(i.suspicious ? { suspicious: true } : {}),
            })),
          },
          ...(raw.memberDiscount ? { memberDiscount: raw.memberDiscount } : {}),
        },
        priceAdviceUsd: check.price
          ? { min: check.price.p25, max: check.price.p75 }
          : (ev.priceAdviceUsd ?? { min: 0, max: 0 }),
      }
    : null

  db.prepare('UPDATE products SET evaluation=?, updated_at=? WHERE id=?').run(
    nextEvaluation ? JSON.stringify(nextEvaluation) : null,
    new Date().toISOString(),
    id
  )
  res.json({ product: findProduct(id), priceCheck: nextEvaluation?.marketSnapshot?.priceCheck ?? null })
})

// ---------- 印刷方式推荐（材质适配 + 优缺点分析，本地规则引擎，无需 AI） ----------
productsRouter.post('/imprint-recommend', async (req: Request, res: Response) => {
  const body = z
    .object({
      source: sourceSchema.optional(),
      materialEn: z.array(z.string()).optional(),
    })
    .parse(req.body ?? {})
  const source = toSourceInfo(body.source ?? sourceSchema.parse({}))
  const result = recommendImprintMethods(source, body.materialEn)
  res.json(result)
})

// ---------- AI 助手对话窗口（免提问，自动补全信息；可返回 listing 补丁） ----------
productsRouter.post('/assistant', async (req: Request, res: Response) => {
  const body = z
    .object({
      productId: z.string().optional(),
      source: sourceSchema.optional(),
      listing: z.any().nullable().optional(),
      fields: z.array(z.string()).max(10).optional(),
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string(),
          })
        )
        .default([]),
    })
    .parse(req.body ?? {})

  let source: SourceInfo
  let listing: Partial<Listing> | null = (body.listing ?? null) as Partial<Listing> | null
  if (body.productId) {
    const current = findProduct(body.productId)
    source = current.source
    listing = (current.listing ?? listing) as Partial<Listing> | null
  } else {
    source = toSourceInfo(body.source ?? sourceSchema.parse({}))
  }

  const settings = loadSettings()
  const result = await runAi(() =>
    assistantChat(source, listing, body.messages as ChatMessage[], settings, body.fields)
  )
  res.json(result)
})

// ---------- 1688 选品自动搜寻（AI 推荐选品方向 + 1688 搜索词） ----------

/**
 * 生成 1688 搜索链接：s.1688.com 的 keywords 参数要求 GBK 编码（UTF-8 会搜不到/打不开），
 * 浏览器端无法做 GBK 编码，必须由后端生成后随结果下发。
 */
function build1688SearchUrl(keyword: string): string {
  try {
    const gbk = iconv.encode(keyword, 'gbk')
    const encoded = Array.from(gbk)
      .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
      .join('')
    return `https://s.1688.com/selloffer/offer_search.htm?keywords=${encoded}`
  } catch {
    return `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}`
  }
}

productsRouter.post('/sourcing-suggest', async (req: Request, res: Response) => {
  const body = z
    .object({
      category: z.string().optional(),
      keywords: z.string().optional(),
      budgetCny: z.coerce.number().nullable().optional(),
      targetPriceUsd: z
        .object({ min: z.coerce.number(), max: z.coerce.number() })
        .nullable()
        .optional(),
      notes: z.string().optional(),
    })
    .parse(req.body ?? {})
  const settings = loadSettings()
  const result = await runAi(() => suggestSourcing(body, settings))
  // 把 AI 给出的搜索词转成可直接打开的 1688 搜索链接（GBK 编码）
  const directions = result.directions.map((d) => ({
    ...d,
    search1688Urls: d.search1688.map(build1688SearchUrl),
  }))
  res.json({
    ...result,
    directions,
    keywords1688Urls: result.keywords1688.map(build1688SearchUrl),
  })
})

// ---------- 深度选品研究（对标 4imprint 热销 → AI 分析 → 1688 找同款） ----------

/** 4imprint 搜索页产品卡片（由 data-* 属性解析，结构已实测确认） */
interface ImprintCard {
  name: string
  url: string
  image: string
  priceFrom: number | null
  priceTo: number | null
  rating: number | null
  category: string
  orderMin: string
  shipDays: string
}

/**
 * 直连抓取 4imprint 产品详情页（静态 HTML，og: 标签齐全）：
 * og:title / og:image / 价格列表（量越大越便宜，min-max 即区间）/ data-rating。
 */
async function fetchImprintDetail(alias: string): Promise<ImprintCard | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(`https://www.4imprint.com/product/${alias}`, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!r.ok) return null
    const html = await r.text()
    const name = decodeEntities(html.match(/og:title["']\s*content=["']([^"']+)["']/i)?.[1] ?? '').trim()
    if (!name) return null
    const image = html.match(/og:image["']\s*content=["']([^"']+)["']/i)?.[1] ?? ''
    const rating = Number(html.match(/data-rating="([\d.]+)"/)?.[1] ?? '') || null
    // 详情页价格从高到低排列（量越大越便宜），min/max 即价格区间
    const prices = [...html.matchAll(/\$([\d]{1,3}(?:\.\d{1,2})?)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n >= 0.1 && n <= 500)
    const priceFrom = prices.length ? Math.min(...prices) : null
    const priceTo = prices.length ? Math.max(...prices) : null
    return {
      name,
      url: `https://www.4imprint.com/product/${alias}`,
      image,
      priceFrom,
      priceTo,
      rating,
      category: '',
      orderMin: '',
      shipDays: '',
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 从 jina 渲染文本 / Bing 结果中提取 4imprint 产品 alias（去重保序） */
function extractImprintAliases(text: string): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(/4imprint\.com\/product\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g)) {
    const alias = m[1]
    // 排除明显非产品路径（如 /product/ 索引页）
    if (!alias || alias.length < 3 || seen.has(alias)) continue
    seen.add(alias)
    aliases.push(alias)
  }
  return aliases
}

/**
 * 通道①（主）：jina 渲染 4imprint 搜索页。
 * 4imprint 的 /search?q= 是 JS 渲染壳页面（静态 HTML 忽略搜索词、返回默认推荐列表），
 * 必须经 jina 渲染集群执行 JS 后才能拿到真实搜索结果（Render 端 jina 已验证可用）。
 */
async function fetch4imprintViaJina(query: string): Promise<string[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 40000)
  try {
    const url = `https://www.4imprint.com/search?q=${encodeURIComponent(query)}&sortby=bestselling`
    const r = await fetch('https://r.jina.ai/' + url, {
      signal: ctrl.signal,
      headers: { 'X-Return-Format': 'text' },
    })
    if (!r.ok) return []
    return extractImprintAliases(await r.text())
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** 通道②（兜底）：jina 渲染 Bing 站内搜索（site:4imprint.com/product），提取产品 alias */
async function fetch4imprintViaBing(query: string): Promise<string[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30000)
  try {
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(`site:4imprint.com/product ${query}`)}&count=20`
    const r = await fetch('https://r.jina.ai/' + bingUrl, {
      signal: ctrl.signal,
      headers: { 'X-Return-Format': 'text' },
    })
    if (!r.ok) return []
    return extractImprintAliases(await r.text())
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 中文关键词 → 4imprint 英文搜索词内置词典（零 AI 调用，毫秒级）。
 * 覆盖常见促销品品类；未命中的词才走 AI 翻译兜底。
 */
const KEYWORD_EN_DICT: Array<[RegExp, string]> = [
  [/数据线|充电线/, 'charging cable'],
  [/充电宝/, 'power bank'],
  [/无线充/, 'wireless charger'],
  [/耳机/, 'earbuds'],
  [/音箱|音响/, 'bluetooth speaker'],
  [/手机支架|手机座|手机托/, 'phone stand'],
  [/U盘|优盘|闪存/, 'usb flash drive'],
  [/围裙/, 'apron'],
  [/帆布袋|帆布包|托特包/, 'canvas tote bag'],
  [/手提袋|购物袋|袋子/, 'tote bag'],
  [/双肩包|背包/, 'backpack'],
  [/保温杯|保温壶|焖烧/, 'insulated tumbler'],
  [/吸管杯/, 'tumbler with straw'],
  [/水杯|水瓶|水壶/, 'water bottle'],
  [/马克杯|咖啡杯|杯子/, 'coffee mug'],
  [/钥匙扣|钥匙链/, 'keychain'],
  [/挂绳|证件带|吊绳/, 'lanyard'],
  [/棒球帽|鸭舌帽|帽子|帽/, 'cap'],
  [/T恤|文化衫|polo衫/i, 't-shirt'],
  [/雨伞|阳伞|伞/, 'umbrella'],
  [/钢笔|圆珠笔|签字笔|笔/, 'pen'],
  [/笔记本|记事本|本子/, 'notebook'],
  [/贴纸/, 'sticker'],
  [/冰箱贴|磁贴/, 'magnet'],
  [/毛巾|浴巾/, 'towel'],
  [/杯垫/, 'coaster'],
  [/餐垫|桌垫/, 'placemat'],
  [/开瓶器/, 'bottle opener'],
  [/保温袋|冰包|午餐袋|冷藏袋/, 'cooler bag'],
  [/野餐垫|野餐毯/, 'picnic blanket'],
  [/毛毯|毯子|盖毯/, 'blanket'],
  [/折叠凳|折叠椅|马扎/, 'folding chair'],
  [/手电筒|电筒|照明/, 'flashlight'],
  [/风扇|扇子/, 'hand fan'],
  [/鼠标垫/, 'mousepad'],
  [/徽章|胸针|勋章/, 'lapel pin'],
  [/口罩/, 'face mask'],
  [/防晒/, 'sunscreen'],
  [/消毒|洗手液/, 'hand sanitizer'],
  [/工具|扳手|螺丝刀/, 'tool kit'],
  [/野餐/, 'picnic'],
  [/瑜伽|健身|运动/, 'fitness'],
  [/宠物|狗|猫/, 'pet'],
  [/玩具/, 'toy'],
  [/解压|捏捏/, 'stress ball'],
  [/收纳|整理/, 'organizer'],
  [/钱包|卡包/, 'wallet'],
  [/腕带|手环/, 'wristband'],
  [/冰袖|袖套/, 'arm sleeves'],
  [/坐垫|靠垫|抱枕/, 'cushion'],
  [/行李牌|登机牌/, 'luggage tag'],
  [/化妆包|洗漱包/, 'cosmetic bag'],
  [/雨衣|雨披/, 'rain poncho'],
  [/太阳镜|墨镜/, 'sunglasses'],
  [/飞盘/, 'frisbee'],
  [/跳绳/, 'jump rope'],
  [/冰袋|冰垫/, 'ice pack'],
  [/砧板|菜板/, 'cutting board'],
  [/烧烤|烤肉/, 'bbq'],
  [/野营|露营/, 'camping'],
]

/** GLS 英文类目 → 4imprint 搜索词映射（类目本身是英文，直接映射更精准） */
const CATEGORY_QUERY_DICT: Array<[RegExp, string]> = [
  [/apron/i, 'apron'],
  [/tote|bag|pouch|sack/i, 'tote bag'],
  [/mug|cup|tumbler|drinkware|bottle/i, 'tumbler'],
  [/pen|pencil|marker|writing/i, 'pen'],
  [/notebook|journal|notepad|pad/i, 'notebook'],
  [/keychain|key tag|keyring/i, 'keychain'],
  [/lanyard/i, 'lanyard'],
  [/umbrella/i, 'umbrella'],
  [/cap|hat|visor|headwear|bandana/i, 'cap'],
  [/shirt|tee|apparel|polo|hoodie|jacket|wearable/i, 't-shirt'],
  [/cable|charging|charger|tech|electronic|usb|computer/i, 'charging cable'],
  [/earbud|headphone|audio|music/i, 'earbuds'],
  [/speaker/i, 'bluetooth speaker'],
  [/phone|mobile/i, 'phone stand'],
  [/power/i, 'power bank'],
  [/sticker|decal/i, 'sticker'],
  [/magnet/i, 'magnet'],
  [/towel/i, 'towel'],
  [/blanket|throw|quilt/i, 'blanket'],
  [/chair|stool|seat|folding/i, 'folding chair'],
  [/fan/i, 'hand fan'],
  [/flashlight|light|lantern|candle/i, 'flashlight'],
  [/tool|hardware|measure|level|screwdriver/i, 'tool kit'],
  [/first aid|medical|health|safety/i, 'first aid kit'],
  [/kitchen|cook|barbecue|bbq|grill|food/i, 'bbq'],
  [/picnic|outdoor|camping|beach/i, 'picnic'],
  [/sport|fitness|gym|exercise|yoga|game|toy|recreation/i, 'fitness'],
  [/pet|dog|cat|animal/i, 'pet'],
  [/wallet|card holder/i, 'wallet'],
  [/backpack|luggage|travel/i, 'backpack'],
  [/cooler|ice/i, 'cooler bag'],
  [/straw/i, 'reusable straw'],
  [/opener/i, 'bottle opener'],
  [/sun|eyewear|glass/i, 'sunglasses'],
  [/rain|poncho/i, 'rain poncho'],
  [/glove|mitt/i, 'gloves'],
  [/sock/i, 'socks'],
  [/badge|pin|lapel|award|trophy|medal/i, 'lapel pin'],
  [/flag|banner|sign|display/i, 'flag'],
  [/calendar|planner|calendar/i, 'planner'],
  [/sticky|note|memo/i, 'sticky notes'],
  [/desk|office|stationery|executive/i, 'desk accessories'],
  [/clock|watch/i, 'clock'],
  [/candy|mint|food/i, 'food gifts'],
  [/auto|car|vehicle|automotive/i, 'car accessories'],
  [/garden|plant|seed/i, 'garden'],
  [/3-d|3d|novelty/i, 'novelty'],
]

/**
 * 构建 4imprint 英文搜索词（毫秒级，几乎不调 AI）：
 * ① 中文关键词词典命中 → 用词典；② GLS 英文类目映射命中 → 用映射；
 * ③ 都未命中 → AI 翻译兜底（仅此时调 AI）。
 */
async function buildImprintQuery(
  body: { category?: string; keywords?: string },
  settings: ReturnType<typeof loadSettings>
): Promise<string> {
  const kw = (body.keywords ?? '').trim()
  const cat = (body.category ?? '').trim()
  if (kw) {
    for (const [re, en] of KEYWORD_EN_DICT) {
      if (re.test(kw)) return en
    }
  }
  if (cat) {
    for (const [re, en] of CATEGORY_QUERY_DICT) {
      if (re.test(cat)) return en
    }
    // 类目未命中映射：类目本身是英文，取主词（去连字符后缀）直接搜
    const main = cat.split(/[-–]/)[0].trim()
    if (main.length >= 3 && /^[A-Za-z0-9 &]+$/.test(main)) return main.toLowerCase()
  }
  if (kw && /[\u4e00-\u9fa5]/.test(kw)) {
    try {
      const en = await runAi(() => researchQueryEn(kw, settings))
      if (en) return en
    } catch {
      /* AI 翻译失败继续兜底 */
    }
  }
  return kw && !/[\u4e00-\u9fa5]/.test(kw) ? kw : 'best selling promotional products'
}

/** 从任意文本提取 1688 offer 链接（兼容 detail/m/redirect 形式，去重保序） */
function extractOfferUrls(text: string): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(/offer\/(\d{8,})\.html/g)) {
    const u = `https://detail.1688.com/offer/${m[1]}.html`
    if (!seen.has(u)) {
      seen.add(u)
      urls.push(u)
    }
  }
  return urls
}

const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 直连抓取文本（跟随重定向）；失败/超时返回 null。搜索与移动端详情共用 */
async function fetchDirect(url: string, timeoutMs = 20000, extraHeaders: Record<string, string> = {}): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': SEARCH_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...extraHeaders,
      },
    })
    if (!r.ok) return null
    const text = await r.text()
    return text || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** 360 搜索结果条目（data-mdurl 真实链接 + h3 标题 + 摘要含价格） */
interface OfferSearchHit {
  offerId: string
  url: string
  title: string
  desc: string
  priceCny: number | null
}

/** 解析 360 搜索结果块：URL 取 data-mdurl，标题取 h3>a（商品卡片回退到纯文本），摘要/价格取 res-desc 或首个 p */
function parse360Results(html: string): OfferSearchHit[] {
  const out: OfferSearchHit[] = []
  const seen = new Set<string>()
  const clean = (s: string) => decodeHtmlEntities(s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).trim()
  for (const b of html.split(/<li[^>]*class="res-list[^"]*"/).slice(1)) {
    const url = b.match(/data-mdurl="(https:\/\/detail\.1688\.com\/offer\/(\d{8,})\.html)"/)?.[1]
    if (!url || seen.has(url)) continue
    seen.add(url)
    const offerId = url.match(/offer\/(\d{8,})\.html/)![1]
    const aStart = b.indexOf('data-mdurl')
    const around = b.slice(Math.max(0, aStart - 2000), aStart + 3000)
    let title = clean(around.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '')
    if (!title) {
      // 商品卡片（1688 广告位）无 h3：标题在纯文本开头，形如「不锈钢 餐盘 …批发-阿里巴巴 价格：￥20.00」
      const plain = clean(b.replace(/<[^>]+>/g, ' '))
      const tf = plain.match(/[A-Za-z0-9\u4e00-\u9fa5（）()、，,．.·%％＋+×*/ \-]{8,150}-阿里巴巴/)?.[0]
      if (tf) title = tf.replace(/\s+/g, '')
    }
    const descRaw =
      b.match(/class="res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ??
      b.match(/class="res-rich[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ??
      b.match(/<p[^>]*>([\s\S]{30,300}?)<\/p>/)?.[1] ??
      ''
    const desc = clean(descRaw)
    // 摘要中的价格：￥20.00 / ￥4.37-6.50（取下限）
    const priceM = desc.match(/[¥￥]\s*(\d{1,5}(?:\.\d{1,2})?)(?:\s*-\s*\d{1,5}(?:\.\d{1,2})?)?/)
    const priceNum = priceM ? Number(priceM[1]) : null
    out.push({
      offerId,
      url,
      title,
      desc,
      priceCny: priceNum != null && priceNum >= 0.1 && priceNum <= 10000 ? priceNum : null,
    })
  }
  return out
}

/** 通道①：360 搜索（site:detail.1688.com 限定，实测 6-7 条/词、直连稳定、摘要自带价格）；失败返回 [] */
async function search1688ViaSo360(query: string): Promise<OfferSearchHit[]> {
  const text = await fetchDirect(`https://www.so.com/s?q=${encodeURIComponent(`site:detail.1688.com ${query}`)}`)
  return text ? parse360Results(text) : []
}

/** 通道②：搜狗搜索（site: 限定，与 360 收录互补，仅提取链接）；失败返回 [] */
async function search1688OffersViaSogou(query: string): Promise<string[]> {
  const text = await fetchDirect(`https://www.sogou.com/web?query=${encodeURIComponent(`site:detail.1688.com ${query}`)}`)
  return text ? extractOfferUrls(text) : []
}

/** 抓取一个 1688 offer 的简要信息（标题/价格/图/MOQ），复用现有多通道抓取 */
async function grabOfferBrief(url: string): Promise<ResearchMatch | null> {
  const offerId = url.match(/offer\/(\d+)/)?.[1] ?? ''
  const clean = offerId ? `https://detail.1688.com/offer/${offerId}.html` : url
  // ① 移动端直连（数据最全）② PC 直连（快）③ jina 兜底
  let g = offerId ? await grab1688Mobile(offerId) : null
  if (!g || (!g.sourceTitle && !g.description)) g = await grab1688Once(clean)
  if (!g || (!g.sourceTitle && !g.description)) g = await grabViaJina(clean)
  if (!g || (!g.sourceTitle && !g.description)) return null
  return {
    url: clean,
    title: g.sourceTitle || g.description.slice(0, 60),
    priceCny: g.priceCny,
    image: g.image,
    moq: g.moq,
  }
}

productsRouter.post('/sourcing-research', async (req: Request, res: Response) => {
  const body = z
    .object({
      category: z.string().optional(),
      keywords: z.string().optional(),
      budgetCny: z.coerce.number().nullable().optional(),
      notes: z.string().optional(),
    })
    .parse(req.body ?? {})
  const settings = loadSettings()

  // ① 构建 4imprint 英文搜索词（内置词典毫秒级命中，仅未命中才调 AI 翻译）
  const zhText = [body.category, body.keywords].filter(Boolean).join(' ') || 'promotional products'
  const queryEn = await buildImprintQuery(body, settings)

  // ② 双通道并行抓 4imprint 产品 alias：jina 渲染搜索页（主）+ Bing site: 站内搜索（兜底）
  const [jinaAliases, bingAliases] = await Promise.all([fetch4imprintViaJina(queryEn), fetch4imprintViaBing(queryEn)])
  const merged: string[] = []
  const seenAlias = new Set<string>()
  for (const a of [...jinaAliases, ...bingAliases]) {
    if (!seenAlias.has(a)) {
      seenAlias.add(a)
      merged.push(a)
    }
  }
  if (merged.length === 0) {
    throw new AppError(502, `4imprint 搜索「${queryEn}」没有找到产品（渲染抓取与站内搜索均未命中），请稍后重试或换个类目`)
  }

  // ③ 并行抓产品详情页（静态 HTML，og: 标签齐全；最多 12 个，控制耗时）
  const detailResults = await Promise.all(merged.slice(0, 12).map((a) => fetchImprintDetail(a)))
  const asiProducts: ImprintCard[] = detailResults.filter((d): d is ImprintCard => d !== null)
  if (asiProducts.length === 0) {
    throw new AppError(502, `4imprint 产品详情抓取失败（共 ${merged.length} 个候选），请稍后重试`)
  }

  // ④ AI 分析热销产品：挑对标品 + 分析卖点 + 生成 1688 中文搜索词（唯一一次 AI 调用）
  const research = await runAi(() =>
    researchSourcing(
      {
        category: body.category,
        keywords: body.keywords,
        budgetCny: body.budgetCny,
        notes: body.notes,
        asiProducts,
      },
      settings
    )
  )

  // ⑤ 每个方向并行：360/搜狗 site: 搜 offer → 并行抓详情（标题/价格/图/MOQ）
  const directions = await Promise.all(
    research.directions.map(async (d) => {
      // 方向内也并行：两个搜索词同时搜（每词 360 + 搜狗双通道）
      const urlLists = await Promise.all(
        d.search1688.slice(0, 2).map(async (q) => {
          const [so, sg] = await Promise.all([search1688ViaSo360(q), search1688OffersViaSogou(q)])
          return [...so.map((h) => h.url), ...sg]
        })
      )
      const offerUrls: string[] = []
      const seenOffer = new Set<string>()
      for (const list of urlLists) {
        for (const u of list.slice(0, 4)) {
          if (!seenOffer.has(u)) {
            seenOffer.add(u)
            offerUrls.push(u)
          }
        }
      }
      const briefs = await Promise.all(offerUrls.slice(0, 4).map((u) => grabOfferBrief(u)))
      const matches = briefs.filter((b): b is ResearchMatch => b !== null).slice(0, 3)
      return { ...d, matches, search1688Urls: d.search1688.map(build1688SearchUrl) }
    })
  )

  res.json({
    ok: true,
    query: zhText,
    queryEn,
    asiProducts,
    directions,
    tips: research.tips,
  })
})

/** 移动端 m.1688.com 直连抓取（UA 伪装 iPhone；页面含规格 JSON 与销量信号） */
async function grab1688Mobile(offerId: string): Promise<GrabbedFetched | null> {
  const html = await fetchDirect(`https://m.1688.com/offer/${offerId}.html`, 15000, {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Referer': 'https://m.1688.com/',
  })
  if (!html || html.length < 5000) return null
  const title =
    (html.match(/<title>([^<]{5,150})<\/title>/)?.[1] ?? '').replace(/[-–—|｜]\s*(阿里巴巴|1688).*$/i, '').trim() ||
    (html.match(/"subject"\s*:\s*"([^"]{5,150})"/)?.[1] ?? '')
  if (!title) return null
  // 规格字段在页面 JSON 中形如 "name":"材质","value":"玻璃"
  const jsonField = (name: string): string => {
    const m = html.match(new RegExp(`"name"\\s*:\\s*"${name}"\\s*,\\s*(?:"[^"]+"\\s*:\\s*"[^"]*"\\s*,\\s*)*"value"\\s*:\\s*"([^"]{1,60})"`))
    return m ? m[1] : ''
  }
  const material = jsonField('材质') || jsonField('主材质')
  const colors = jsonField('颜色') || jsonField('颜色分类')
  const size = jsonField('尺寸') || jsonField('规格') || jsonField('直径')
  const priceM = html.match(/[¥￥]\s*(\d{1,5}(?:\.\d{1,2})?)/) ?? html.match(/"price"\s*:\s*"?(\d{1,5}(?:\.\d{1,2})?)"?/)
  const priceNum = priceM ? Number(priceM[1]) : null
  const priceCny = priceNum != null && priceNum >= 0.1 && priceNum <= 10000 ? priceNum : null
  const moqM = html.match(/(\d+)\s*件起批/) ?? html.match(/"beginAmount"\s*:\s*(\d+)/)
  const moq = moqM ? Number(moqM[1]) : null
  const image = html.match(/"(https?:\/\/cbu01\.alicdn\.com\/img\/ibank\/[^"]+?\.(?:jpg|png|webp))"/)?.[1] ?? ''
  const desc = html.match(/name="description"\s+content="([^"]{10,300})"/)?.[1] ?? ''
  return {
    sourceTitle: title,
    sourceKeywords: [],
    description: desc,
    materialCn: material,
    colorsCn: colors,
    sizeCn: size,
    weightG: null,
    cartonSpecCm: '',
    pcsPerCarton: null,
    cartonGwKg: null,
    moq,
    priceCny,
    image,
    images: image ? [image] : [],
  }
}

// ============================================================
// 每日自动选品
// ============================================================
// 粗筛刻意放宽（用户要求）：只要不是「自带 logo 且完全不能定制」「价格离谱」就进候选，
// 剩下的判断交给 v2 评分 + 人工审核。

/** 跨境/外贸信号：命中即加分 */
const CROSS_BORDER_RE = /跨境|外贸|亚马逊|amazon|速卖通|temu|shein|独立站|一件代发|出口|海外|跨境专供/i
/** 支持定制的信号 */
const CUSTOM_RE = /定制|订制|LOGO|logo|印刷|丝印|烫金|烫印|刺绣|绣花|贴牌|印图|激光|刻字|可加|打样/
/** 品牌/侵权风险信号 */
const BRAND_RE = /品牌|商标|专利|授权|迪士尼|漫威|NBA|卡通|联名/

/** 内置品类池：没有手动输入时按日期轮换，保证每天有不同方向 */
const DAILY_KEYWORD_POOL = [
  '定制帆布托特包', '定制不锈钢保温杯', '定制办公笔记本', '定制棒球帽',
  '定制运动毛巾', '定制鼠标垫', '定制折叠购物袋', '定制硅胶杯垫',
  '定制行李牌', '定制颈枕', '定制帆布袋 手提', '定制登山扣水壶',
  '定制车载手机支架', '定制瑜伽垫', '定制野餐垫', '定制笔筒',
]

async function pickDailyKeywords(prompt: string | undefined, settings: ReturnType<typeof loadSettings>) {
  if (prompt && prompt.trim()) {
    try {
      const d = await callChatJson<{ keywords: string[] }>(
        settings,
        '你是外贸选品助手。只输出 JSON：{"keywords":["中文1688搜索词",...]}，4-6 个，每个 ≤12 字，直接可用于 1688 搜索。不要解释。',
        `用户要求：${prompt.trim()}\n请给出 4-6 个最可能搜到美国促销礼品（ASI）适销产品的 1688 中文搜索词。`,
        0.4
      )
      const kws = (d?.keywords ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
      if (kws.length) return { keywords: kws, source: 'prompt' as const }
    } catch {
      // AI 失败就退化为内置池 + 用户原话
    }
    return { keywords: [prompt.trim().slice(0, 20)], source: 'prompt-raw' as const }
  }
  const day = Math.floor(Date.now() / 86400000)
  const start = day % DAILY_KEYWORD_POOL.length
  const kws = [0, 1, 2, 3].map((i) => DAILY_KEYWORD_POOL[(start + i) % DAILY_KEYWORD_POOL.length])
  return { keywords: kws, source: 'pool' as const }
}

/** 已存在（含回收站）的 offerId，用于去重，避免重复做过的品 */
function existingOfferIds(): Set<string> {
  const rows = db.prepare('SELECT source_url FROM products').all() as unknown as { source_url: string }[]
  const set = new Set<string>()
  for (const r of rows) {
    const m = (r.source_url || '').match(/offer\/(\d{6,})/)
    if (m) set.add(m[1])
  }
  return set
}

/** 把一条抓取结果落库为「自动选品」产品 */
function insertAutoProduct(
  source: SourceInfo,
  evaluation: Evaluation | null,
  selectionReason: string
): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO products (id, draft_id, source_title, source_url, description, source_keywords, amazon_title,
      price_cny, price_max_cny, moq, supplier, alt_suppliers, material_cn, colors_cn, size_cn, weight_g,
      carton_l_cm, carton_w_cm, carton_h_cm, pcs_per_carton, carton_gw_kg,
      images, category, notes, score, verdict, evaluation, listing, similar, status, created_at, updated_at,
      origin, selection_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    null,
    source.sourceTitle,
    source.sourceUrl,
    source.description,
    JSON.stringify(source.sourceKeywords ?? []),
    source.amazonTitle,
    source.priceCny ?? null,
    source.priceMaxCny ?? null,
    source.moq ?? null,
    source.supplier,
    source.altSuppliers ?? '',
    source.materialCn,
    source.colorsCn,
    source.sizeCn,
    source.weightG ?? null,
    source.cartonLCm ?? null,
    source.cartonWCm ?? null,
    source.cartonHCm ?? null,
    source.pcsPerCarton ?? null,
    source.cartonGwKg ?? null,
    JSON.stringify(source.images ?? []),
    source.category,
    source.notes,
    evaluation?.score ?? null,
    evaluation?.verdict ?? null,
    evaluation ? JSON.stringify(evaluation) : null,
    null,
    '{}',
    'sourced',
    now,
    now,
    'auto',
    selectionReason
  )
  // 落库后立刻算 v2（只写 score_v2 等列）
  try {
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as unknown as Row
    const s = computeRowScore(row)
    db.prepare(
      'UPDATE products SET score_v2=?, verdict_v2=?, margin_v2=?, ceiling_cny=?, scored_at=? WHERE id=?'
    ).run(s.score, s.verdict, s.margin, s.ceilingCny, new Date().toISOString(), id)
  } catch {
    /* 评分失败不影响入库 */
  }
  return id
}

productsRouter.post('/sourcing/daily', async (req: Request, res: Response) => {
  const body = z
    .object({ prompt: z.string().max(600).optional(), limit: z.coerce.number().min(1).max(10).optional() })
    .parse(req.body ?? {})
  const settings = loadSettings()
  const limit = body.limit ?? 5

  const { keywords, source: kwSource } = await pickDailyKeywords(body.prompt, settings)
  const already = existingOfferIds()

  // ① 搜 1688：360（带价格）+ 搜狗（链接互补）
  const hits = new Map<string, OfferSearchHit & { keyword: string }>()
  for (const q of keywords.slice(0, 4)) {
    const [so, sg] = await Promise.all([search1688ViaSo360(q), search1688OffersViaSogou(q)])
    for (const h of so) if (!hits.has(h.offerId)) hits.set(h.offerId, { ...h, keyword: q })
    for (const u of sg) {
      const id = u.match(/offer\/(\d{6,})/)?.[1]
      if (id && !hits.has(id)) {
        hits.set(id, { offerId: id, url: u, title: '', desc: '', priceCny: null, keyword: q })
      }
    }
  }

  // ② 粗筛（放宽）：去掉做过的、价格离谱的；跨境信号与有价格的优先
  const candidates = [...hits.values()]
    .filter((h) => !already.has(h.offerId))
    .filter((h) => h.priceCny == null || (h.priceCny >= 0.5 && h.priceCny <= 150))
    .map((h) => ({
      ...h,
      crossBorder: CROSS_BORDER_RE.test(`${h.title} ${h.desc}`),
      hasPrice: h.priceCny != null,
    }))
    .sort(
      (a, b) =>
        Number(b.crossBorder) - Number(a.crossBorder) || Number(b.hasPrice) - Number(a.hasPrice)
    )

  // ③ 逐条抓详情 → 判断题设 → AI 评估 → 入库
  const created: Array<{ id: string; title: string; priceCny: number | null; score: number | null; reason: string }> = []
  const skipped: Array<{ url: string; reason: string }> = []

  for (const c of candidates) {
    if (created.length >= limit) break
    let grabbed
    try {
      grabbed = await fetch1688Page(c.url)
    } catch {
      skipped.push({ url: c.url, reason: '抓取失败' })
      continue
    }
    if (!grabbed.ok) {
      skipped.push({ url: c.url, reason: grabbed.message })
      continue
    }
    const f = grabbed.fetched
    const carton = f.cartonSpecCm.match(
      /(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)/
    )
    const source = toSourceInfo(
      sourceSchema.parse({
        sourceUrl: c.url,
        sourceTitle: f.sourceTitle,
        sourceKeywords: f.sourceKeywords,
        description: f.description,
        materialCn: f.materialCn,
        colorsCn: f.colorsCn,
        sizeCn: f.sizeCn,
        weightG: f.weightG ?? undefined,
        cartonLCm: carton ? Number(carton[1]) : undefined,
        cartonWCm: carton ? Number(carton[2]) : undefined,
        cartonHCm: carton ? Number(carton[3]) : undefined,
        pcsPerCarton: f.pcsPerCarton ?? undefined,
        cartonGwKg: f.cartonGwKg ?? undefined,
        moq: f.moq ?? undefined,
        priceCny: f.priceCny ?? c.priceCny ?? undefined,
      })
    )

    const text = `${source.sourceTitle} ${source.description} ${source.materialCn}`
    const canCustomize = CUSTOM_RE.test(text)
    const hasBrand = BRAND_RE.test(source.sourceTitle)
    // 自带 logo 且完全不支持定制 → 直接 pass（用户要求）
    if (!canCustomize && hasBrand) {
      skipped.push({ url: c.url, reason: '疑似自带品牌且不支持定制' })
      continue
    }

    let evaluation: Evaluation
    try {
      evaluation = await evaluateSource(source, settings)
    } catch (e) {
      skipped.push({ url: c.url, reason: `AI 评估失败：${(e as Error).message}` })
      continue
    }

    const signals: string[] = []
    if (c.crossBorder) signals.push('跨境/外贸信号')
    if (canCustomize) signals.push('支持定制')
    if (!hasBrand) signals.push('未见品牌风险')
    if (source.priceCny) signals.push(`1688 报价 ¥${source.priceCny}`)
    if (source.moq) signals.push(`起订 ${source.moq} 件`)

    const reason =
      `搜索词「${c.keyword}」命中；` +
      (signals.length ? signals.join('、') : '仅价格/标题命中') +
      (evaluation.summary ? `。AI 初判：${evaluation.summary.slice(0, 80)}` : '')

    const id = insertAutoProduct(source, evaluation, reason)
    created.push({
      id,
      title: source.sourceTitle,
      priceCny: source.priceCny ?? null,
      score: evaluation.score ?? null,
      reason,
    })
  }

  res.json({
    ok: true,
    keywords,
    keywordSource: kwSource,
    scanned: hits.size,
    candidates: candidates.length,
    created,
    skipped: skipped.slice(0, 12),
  })
})
