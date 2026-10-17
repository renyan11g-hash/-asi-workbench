import { randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { AiError } from '../services/ai'
import { callChatJson } from '../services/ai'
import { applyQc, assistantChat, chatEvaluateSource, evaluateSource, findSimilarForSource, generateListing, generateListingQuestions, regenerateListingFields, suggestSourcing } from '../services/workbench'
import { buildFindSimilarPrompt, ChatMessage, ListingAnswer } from '../services/prompts'
import { buildPriceGrid } from '../services/pricing'
import { buildGlsWorkbook } from '../services/gls-export'
import { recommendImprintMethods } from '../services/imprint-recommend'
import { Evaluation, Listing, Product, ProductStatus, SimilarResearch, SourceInfo } from '../types'
import { loadSettings } from './settings'

export const productsRouter: Router = Router()

const sourceSchema = z.object({
  sourceTitle: z.string().default(''),
  sourceUrl: z.string().default(''),
  description: z.string().default(''),
  sourceKeywords: z.array(z.string()).default([]),
  amazonTitle: z.string().default(''),
  priceCny: z.coerce.number().nullable().optional(),
  priceMaxCny: z.coerce.number().nullable().optional(),
  moq: z.coerce.number().nullable().optional(),
  supplier: z.string().default(''),
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
  status: z.enum(['sourced', 'listed', 'archived']).optional(),
  /** 关联的选品评估草稿 id：同一草稿重复保存时更新已关联产品，避免重复建品 */
  draftId: z.string().max(100).optional(),
})

const updateSchema = z.object({
  source: sourceSchema.partial().optional(),
  evaluation: z.any().nullable().optional(),
  listing: z.any().nullable().optional(),
  status: z.enum(['sourced', 'listed', 'archived']).optional(),
})

type SourceInput = z.infer<typeof sourceSchema>

function toSourceInfo(s: SourceInput): SourceInfo {
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
  draft_id: string | null
  source_title: string
  source_url: string
  description: string
  source_keywords: string
  amazon_title: string
  price_cny: number | null
  price_max_cny: number | null
  moq: number | null
  supplier: string
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    trashedAt: r.trashed_at ?? null,
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

function findProduct(id: string): Product {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as unknown as Row | undefined
  if (!row) throw new AppError(404, '产品不存在')
  return rowToProduct(row)
}

async function runAi<T>(fn: () => Promise<T>): Promise<T> {
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
    where.push("status != 'trashed'")
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
productsRouter.post('/preview/evaluate', async (req: Request, res: Response) => {
  const source = toSourceInfo(sourceSchema.parse(req.body?.source ?? {}))
  const settings = loadSettings()
  const evaluation = await runAi(() => evaluateSource(source, settings))
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
    })
    .parse(req.body ?? {})
  const source = toSourceInfo(body.source)
  const settings = loadSettings()
  const listing = await runAi(() =>
    generateListing(source, settings, body.answers as ListingAnswer[] | undefined, (body.similar ?? null) as SimilarResearch | null)
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

/**
 * 需求 8：从 1688 链接自动抓取产品资料（标题 / 关键词 / 描述 / 规格参数尽力提取）。
 * 1688 页面有反爬与登录墙，能抓到多少算多少，抓不到的字段返回空并由前端提示用户手填或问商家。
 */
productsRouter.post('/preview/fetch-1688', async (req: Request, res: Response) => {
  const url = String((req.body as Record<string, unknown>)?.url ?? '').trim()
  if (!/^https?:\/\/[^/]*\.?1688\.com\//i.test(url)) {
    throw new AppError(400, '请输入 1688 商品链接（如 https://detail.1688.com/offer/xxx.html）')
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://www.1688.com/',
      },
    })
    if (!r.ok) throw new AppError(502, `1688 返回 HTTP ${r.status}（可能有反爬或需要登录），请手动填写或用「问商家话术」向客服索取`)
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

    const found = [title, keywords, desc, material, colors, size, weight, cartonSpec, pcsPerCarton, cartonGw]
      .filter(Boolean).length
    res.json({
      ok: found > 0,
      fetched: {
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
      },
      message:
        found > 0
          ? `抓到 ${found} 项资料，请核对后补充缺失字段（箱规等建议用「问商家话术」向客服确认）`
          : '页面被 1688 反爬拦截或结构识别失败，请手动填写，或复制「问商家话术」发给客服',
    })
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError(502, `抓取失败：${err instanceof Error ? err.message : String(err)}。请手动填写或问商家`)
  } finally {
    clearTimeout(timer)
  }
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
      price_cny=?, price_max_cny=?, moq=?, supplier=?, material_cn=?, colors_cn=?, size_cn=?, weight_g=?,
      carton_l_cm=?, carton_w_cm=?, carton_h_cm=?, pcs_per_carton=?, carton_gw_kg=?,
      images=?, category=?, notes=?, score=?, verdict=?, evaluation=?, listing=?, status=?, updated_at=? WHERE id=?`
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
    status,
    now,
    id
  )
  // 市场调研结果（看图找类似）只在显式传入时覆盖，避免同步流程意外清空
  if (similar !== undefined) {
    db.prepare('UPDATE products SET similar=? WHERE id=?').run(
      similar ? JSON.stringify(similar) : null,
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

  const id = randomUUID()
  db.prepare(
    `INSERT INTO products (id, draft_id, source_title, source_url, description, source_keywords, amazon_title,
      price_cny, price_max_cny, moq, supplier, material_cn, colors_cn, size_cn, weight_g,
      carton_l_cm, carton_w_cm, carton_h_cm, pcs_per_carton, carton_gw_kg,
      images, category, notes, score, verdict, evaluation, listing, similar, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    body.draftId ?? null,
    s.sourceTitle,
    s.sourceUrl,
    s.description,
    JSON.stringify(s.sourceKeywords ?? []),
    s.amazonTitle,
    s.priceCny ?? null,
    s.priceMaxCny ?? null,
    s.moq ?? null,
    s.supplier,
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
    similar ? JSON.stringify(similar) : null,
    body.status ?? (listing ? 'listed' : 'sourced'),
    now,
    now
  )
  res.status(201).json({ product: findProduct(id) })
})

// ---------- 单条读取 ----------
productsRouter.get('/:id', async (req: Request, res: Response) => {
  res.json({ product: findProduct(String(req.params.id)) })
})

// ---------- 更新 ----------
productsRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id)
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

  updateProductRow(id, source, evaluation, listing, status, new Date().toISOString())
  res.json({ product: findProduct(id) })
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
  const current = findProduct(id)
  const settings = loadSettings()
  const evaluation = await runAi(() => evaluateSource(current.source, settings))
  db.prepare('UPDATE products SET score=?, verdict=?, evaluation=?, updated_at=? WHERE id=?').run(
    evaluation.score,
    evaluation.verdict,
    JSON.stringify(evaluation),
    new Date().toISOString(),
    id
  )
  res.json({ product: findProduct(id) })
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
  res.json({ product: findProduct(id) })
})

// ---------- AI：生成 Listing（落库） ----------
productsRouter.post('/:id/listing', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const current = findProduct(id)
  const settings = loadSettings()
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
    })
    .parse(req.body ?? {})
  const listing = await runAi(() =>
    generateListing(current.source, settings, body.answers as ListingAnswer[] | undefined, current.similar)
  )
  db.prepare('UPDATE products SET listing=?, status=?, updated_at=? WHERE id=?').run(
    JSON.stringify(listing),
    'listed',
    new Date().toISOString(),
    id
  )
  res.json({ product: findProduct(id) })
})

// ---------- AI：分块重新生成（只重生成指定区块字段，不重生成整个 listing；不落库，由前端确认后保存） ----------
const REGEN_FIELD_ENUM = [
  'title',
  'summary',
  'description',
  'keywords',
  'category',
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
  const settings = loadSettings()
  const values = await runAi(() =>
    regenerateListingFields(
      current.source,
      current.listing as Partial<Listing> | null,
      body.fields,
      body.instruction,
      settings
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
  const settings = loadSettings()
  const similar = await runAi(() => findSimilarForSource(current.source, settings))
  db.prepare('UPDATE products SET similar=?, updated_at=? WHERE id=?').run(
    JSON.stringify(similar),
    new Date().toISOString(),
    id
  )
  res.json({ similar, product: findProduct(id) })
})

// ---------- 价格表重算 ----------
productsRouter.post('/:id/reprice', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const current = findProduct(id)
  const settings = loadSettings()
  const { rows } = buildPriceGrid(current.source, settings)
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
  res.json({ priceGrid: rows, product: findProduct(id) })
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
  res.json(result)
})