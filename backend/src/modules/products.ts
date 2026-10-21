import { randomUUID } from 'crypto'
import iconv from 'iconv-lite'
import { saveSourcingHistory } from './sourcing-history'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { AiError } from '../services/ai'
import { callChatJson } from '../services/ai'
import { applyQc, assistantChat, chatEvaluateSource, evaluateSource, findSimilarForSource, generateListing, generateListingQuestions, identifyImageProduct, rankSuppliers, regenerateListingFields, researchQueryEn, researchSourcing, suggestSourcing } from '../services/workbench'
import type { ResearchMatch, SupplierCandidate } from '../services/workbench'
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

/** 抓取提取出的商品资料（抓到多少算多少，缺失字段为空值） */
interface GrabbedFetched {
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
}

/** 统计抓到几项有效资料 */
function countFound(g: GrabbedFetched): number {
  return [
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
async function fetch1688Page(url: string): Promise<{ ok: boolean; found: number; message: string; fetched: GrabbedFetched }> {
  if (!/^https?:\/\/[^/]*\.?1688\.com\//i.test(url)) {
    throw new AppError(400, '请输入 1688 商品链接（如 https://detail.1688.com/offer/xxx.html）')
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
  const { ok, fetched, message } = await fetch1688Page(url)
  res.json({ ok, fetched, message })
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
    })
  )
  const settings = loadSettings()
  const evaluation = await runAi(() => evaluateSource(source, settings))
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
    // 该列迁移时为 TEXT NOT NULL DEFAULT '{}'，写 null 会触发 NOT NULL constraint failed（500）
    similar ? JSON.stringify(similar) : '{}',
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

/** 通道①：jina 渲染抓取 Bing 搜索结果（site:detail.1688.com 限定），提取具体 1688 offer 链接；失败返回 [] */
async function search1688OffersViaBing(query: string): Promise<string[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25000)
  try {
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(`site:detail.1688.com ${query}`)}&count=20`
    const r = await fetch('https://r.jina.ai/' + bingUrl, {
      signal: ctrl.signal,
      headers: { 'X-Return-Format': 'text' },
    })
    if (!r.ok) return []
    return extractOfferUrls(await r.text())
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** 通道②：Bing 宽搜（不限定 site:，用「1688」关键词），兜底 site: 收录不足的词；失败返回 [] */
async function search1688OffersViaBingWide(query: string): Promise<string[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25000)
  try {
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(`${query} 1688.com 详情`)}&count=20`
    const r = await fetch('https://r.jina.ai/' + bingUrl, {
      signal: ctrl.signal,
      headers: { 'X-Return-Format': 'text' },
    })
    if (!r.ok) return []
    return extractOfferUrls(await r.text())
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** 通道③：jina 直抓 1688 搜索结果页（GBK 编码 PC 版 selloffer 页），最接近站内真实搜索；失败返回 [] */
async function search1688ViaJinaSearchPage(query: string): Promise<string[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 45000)
  try {
    const r = await fetch('https://r.jina.ai/' + build1688SearchUrl(query), {
      signal: ctrl.signal,
      headers: { 'X-Return-Format': 'text' },
    })
    if (!r.ok) return []
    const text = await r.text()
    if (text.length < 300) return []
    return extractOfferUrls(text)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** 抓取一个 1688 offer 的简要信息（标题/价格/图/MOQ），复用现有多通道抓取 */
async function grabOfferBrief(url: string): Promise<ResearchMatch | null> {
  const offerId = url.match(/offer\/(\d+)/)?.[1] ?? ''
  const clean = offerId ? `https://detail.1688.com/offer/${offerId}.html` : url
  // 先直连（快），失败再 jina（慢但能绕反爬）
  let g = await grab1688Once(clean)
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

  // ⑤ 每个方向并行：Bing site:detail.1688.com 搜 offer → 并行抓详情（标题/价格/图/MOQ）
  const directions = await Promise.all(
    research.directions.map(async (d) => {
      // 方向内也并行：两个搜索词同时搜
      const urlLists = await Promise.all(d.search1688.slice(0, 2).map((q) => search1688OffersViaBing(q)))
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

// ---------- 以图找源（上传产品图片 → AI 识图 → 1688 搜商家 → 抓详情 → AI 排序） ----------

/** 从 1688 页面文本提取商家实力/销量/资质信号（供 AI 排序） */
function extractSupplierSignals(text: string): string {
  const hits: string[] = []
  const add = (label: string, re: RegExp) => {
    const m = text.match(re)
    if (m) hits.push(label + (m[1] ? `:${m[0].slice(0, 40)}` : ''))
  }
  // 店铺实力标签
  if (/实力商家|实力工厂/.test(text)) hits.push('实力商家')
  if (/超级工厂/.test(text)) hits.push('超级工厂')
  if (/源头工厂|工厂直供|自产自销|生产厂家/.test(text)) hits.push('源头工厂')
  if (/跨境专供|跨境专属|跨境货源/.test(text)) hits.push('跨境专供')
  if (/现货|速发|48小时|24小时|当天发货/.test(text)) hits.push('现货速发')
  if (/支持定制|来图定制|logo定制|定制logo|OEM|ODM/i.test(text)) hits.push('支持定制')
  if (/一件代发/.test(text)) hits.push('一件代发')
  // 销量信号
  add('成交', /(?:近\d+日|近\d+个月)?(?:成交|已售|销量)[^\d]{0,6}[\d.]+\s*(?:万|千)?[件笔单]?/)
  add('回头率', /回头率[:：]?\s*[\d.]+%?/)
  add('复购', /复购率[:：]?\s*[\d.]+%?/)
  // 资质/检测
  if (/检测报告|质检报告|SGS|FDA|食品级|LFGB/.test(text)) hits.push('有检测/资质标注')
  if (/UN38\.3|MSDS|空运鉴定/.test(text)) hits.push('电池运输报告')
  if (/CE|FCC|UL|CPC|ASTM/i.test(text)) hits.push('认证标注')
  // 店铺年限
  add('店铺年限', /(?:入驻|经营|开店)[^\d]{0,4}\d+\s*年/)
  return hits.join('；')
}

/** 抓取一个 1688 offer 详情并组装候选商家（含信号提取）；失败返回 null */
async function grabSupplierCandidate(url: string): Promise<SupplierCandidate | null> {
  const offerId = url.match(/offer\/(\d+)/)?.[1] ?? ''
  if (!offerId) return null
  const clean = `https://detail.1688.com/offer/${offerId}.html`
  let g = await grab1688Once(clean)
  if (!g || (!g.sourceTitle && !g.description)) g = await grabViaJina(clean)
  if (!g || (!g.sourceTitle && !g.description)) return null
  const rawText = [g.sourceTitle, g.description.slice(0, 600), g.materialCn, g.sizeCn].filter(Boolean).join(' ')
  return {
    offerId,
    url: clean,
    title: g.sourceTitle || g.description.slice(0, 60),
    priceCny: g.priceCny,
    moq: g.moq,
    image: g.image,
    raw: extractSupplierSignals(rawText),
  }
}

/**
 * 多通道 1688 offer 搜索（带兜底，结果越多越好）：
 * 第 1 词：site: → 宽搜 → jina 直抓搜索页；若仍不足 4 条，继续用下一个词。
 * 返回去重后的 offer 链接列表（保序，宽泛词在前 = 相关度优先）。
 */
async function search1688OffersMultiChannel(queries: string[]): Promise<string[]> {
  const all: string[] = []
  const seen = new Set<string>()
  const pushAll = (list: string[]) => {
    for (const u of list) {
      if (!seen.has(u)) {
        seen.add(u)
        all.push(u)
      }
    }
  }
  for (const q of queries.slice(0, 5)) {
    // 三通道逐词降级；第一轮并行 site: + 搜索页直抓（最快的两条路），不够再宽搜
    const [site, page] = await Promise.all([search1688OffersViaBing(q), search1688ViaJinaSearchPage(q)])
    pushAll(site)
    pushAll(page)
    if (all.length < 4) pushAll(await search1688OffersViaBingWide(q))
    if (all.length >= 8) break // 足够了，停止后续词
  }
  return all
}

/**
 * POST /sourcing-by-image —— 以图找源：
 * ① AI 识图（1-6 张图，产品识别 + 1688 中文搜索词长短混合 + 合规要点）
 * ② 多通道搜 offer 链接（Bing site: → jina 直抓 1688 搜索页 → Bing 宽搜，逐词降级）
 * ③ 并行抓 offer 详情（标题/价格/MOQ/图 + 实力/销量/资质信号）
 * ④ AI 按现货/定制/实力/销量/跨境/合规打分排序
 */
productsRouter.post('/sourcing-by-image', async (req: Request, res: Response) => {
  const body = z
    .object({
      images: z.array(z.string().min(32)).min(1).max(6),
      notes: z.string().optional(),
      budgetCny: z.coerce.number().nullable().optional(),
    })
    .parse(req.body ?? {})
  const settings = loadSettings()

  // ① AI 识图（唯一一次视觉调用，支持多图）
  const identified = await runAi(() => identifyImageProduct(body.images, settings, body.notes))
  if (!identified.productName || identified.search1688.length === 0) {
    throw new AppError(502, 'AI 未能从图片识别出可搜索的产品，请换一张更清晰的产品图（单产品、正面照最佳）')
  }

  // ② 多通道搜索 offer 链接（长短词逐个尝试，直到足够）
  const offerUrls = await search1688OffersMultiChannel(identified.search1688)
  if (offerUrls.length === 0) {
    throw new AppError(502, `1688 搜索「${identified.search1688[0]}」没有找到商品链接，请稍后重试或补充说明`)
  }

  // ③ 并行抓 offer 详情（最多 12 个，控制耗时）
  const candidates = (
    await Promise.all(offerUrls.slice(0, 12).map((u) => grabSupplierCandidate(u)))
  ).filter((c): c is SupplierCandidate => c !== null)
  if (candidates.length === 0) {
    throw new AppError(502, '1688 商品详情抓取失败（反爬拦截），请稍后重试')
  }

  // ④ AI 排序（现货/定制/实力/销量/跨境/合规）
  const rank = await runAi(() =>
    rankSuppliers(
      {
        productName: identified.productName,
        compliance: identified.compliance,
        budgetCny: body.budgetCny,
        notes: body.notes,
        candidates,
      },
      settings
    )
  )

  res.json({
    ok: true,
    identified,
    candidatesCount: candidates.length,
    ...rank,
  })
})

/**
 * POST /sourcing-by-image/chat —— 以图找源后续对话：
 * AI 带着识图结果 + 排序结果回答追问（如"第 2 家为什么分低""帮我对比前 3 家"）。
 */
productsRouter.post('/sourcing-by-image/chat', async (req: Request, res: Response) => {
  const body = z
    .object({
      context: z.object({
        identified: z.unknown(),
        ranked: z.array(z.unknown()).default([]),
      }),
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().min(1),
          })
        )
        .min(1)
        .max(30),
    })
    .parse(req.body ?? {})
  const settings = loadSettings()

  const system = `你是 1688 以图找源助手。用户刚完成一次以图找源：下面是识图结果与商家排序结果（JSON）。
基于这些数据回答追问：对比商家、解释评分理由、分析合规风险、建议谈判要点、推荐更适合的方向等。
要求：中文回答，简洁务实；引用具体商家时用其标题或序号；数据里没有的信息要说明需向商家核实，不要编造。

【识图结果】
${JSON.stringify(body.context.identified)}

【商家排序】
${JSON.stringify(body.context.ranked)}`

  const reply = await runAi(() =>
    callChatJson<Record<string, unknown>>(settings, system, body.messages.map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`).join('\n'), 0.6).then(
      (r) => String(r.reply ?? r.content ?? JSON.stringify(r))
    )
  )
  res.json({ ok: true, reply })
})