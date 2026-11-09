/**
 * 产品结构化资料 API（批量生产系统 V1 · 第一阶段）。
 *
 * 三件事：
 *   ① 看：每个产品一张「产品信息卡」，14 个字段，未知的标黄
 *   ② 改：人工直接改，改完就是后续生成的事实来源
 *   ③ 提：单条重新提取（同步，10~20 秒）；批量提取（后台任务，能取消）
 *
 * 原始资料（products.source_* / description）一个字节都不动，结构化结果单独一张表。
 */

import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { loadSettings } from './settings'
import type { ProductSpecs, ProductSpecRecord } from '../types'
import {
  SPEC_FIELDS,
  SPEC_KEYS,
  UNKNOWN,
  emptySpecs,
  extractSpecs,
  getSpecRecord,
  listSpecRecords,
  normalizeSpecs,
  saveSpecs,
  specsSourceHash,
  specsStale,
} from '../services/product-specs'
import { findProduct } from './products'

export const productSpecsRouter: Router = Router()

export interface ProductCard {
  productId: string
  code: string
  title: string
  /** 产品的类目（1688 类目提示；没有就用已生成 listing 的类目） */
  category: string
  status: string
  hasListing: boolean
  updatedAt: string
  thumb: string
  thumbFallback: string
  /** 这个产品还有没有没审的批量草稿（有 = 再生成会替换掉它） */
  pendingDraft: {
    count: number
    /** 草稿被人改过：再生成会覆盖人工修改，界面要提醒 */
    edited: boolean
  }
  specs: {
    filled: number
    total: number
    unknownFields: string[]
    extractedAt: string | null
    editedAt: string | null
    /** 原始资料改过了，结构化结果可能过期 */
    stale: boolean
  }
}

interface CardRow {
  id: string
  code: string
  source_title: string
  category: string
  /** 评估里的 ASI 类目（老产品没有 products.category 时兜底，让「按类别筛选」真的能用） */
  eval_category: string | null
  status: string
  updated_at: string
  listing: string | null
  has_src_images: number
  description: string
  material_cn: string
  colors_cn: string
  size_cn: string
  weight_g: number | null
  carton_l_cm: number | null
  carton_w_cm: number | null
  carton_h_cm: number | null
  pcs_per_carton: number | null
  carton_gw_kg: number | null
  notes: string
}

/**
 * 产品信息卡列表（资料卡页与批量生产中心共用同一份数据，口径一致）。
 * 只读 products 的轻量字段，不把 images / listing 大对象读出来。
 */
export function listProductCards(opts?: { includeTrashed?: boolean }): ProductCard[] {
  const where = opts?.includeTrashed ? '' : "WHERE status != 'trashed'"
  // 类目兜底：优先 1688 类目，其次评估里的 ASI 类目（json_extract 只在 JSON 合法时取，避免脏数据报错）。
  // 有些环境没有 json 函数，取不到就退回空串，不影响主流程。
  const richSql = `SELECT id, code, source_title, category, status, updated_at, listing,
              description, material_cn, colors_cn, size_cn, weight_g,
              carton_l_cm, carton_w_cm, carton_h_cm, pcs_per_carton, carton_gw_kg, notes,
              CASE WHEN json_valid(evaluation) THEN json_extract(evaluation, '$.asiCategories[0]') END AS eval_category,
              CASE WHEN images NOT IN ('', '[]') THEN 1 ELSE 0 END AS has_src_images
       FROM products ${where}
       ORDER BY code DESC`
  const simpleSql = `SELECT id, code, source_title, category, status, updated_at, listing,
              description, material_cn, colors_cn, size_cn, weight_g,
              carton_l_cm, carton_w_cm, carton_h_cm, pcs_per_carton, carton_gw_kg, notes,
              '' AS eval_category,
              CASE WHEN images NOT IN ('', '[]') THEN 1 ELSE 0 END AS has_src_images
       FROM products ${where}
       ORDER BY code DESC`
  let rows: CardRow[]
  try {
    rows = db.prepare(richSql).all() as unknown as CardRow[]
  } catch {
    rows = db.prepare(simpleSql).all() as unknown as CardRow[]
  }

  const specsMap = listSpecRecords(rows.map((r) => r.id))

  // 未审草稿：同一产品可能有一条 staged 草稿，界面要提示「再生成会替换」
  const draftMap = new Map<string, { count: number; edited: boolean }>()
  try {
    const drafts = db
      .prepare(
        `SELECT product_id,
                COUNT(*) AS n,
                MAX(CASE WHEN edited_at IS NOT NULL AND edited_at != '' THEN 1 ELSE 0 END) AS edited
         FROM listing_reviews
         WHERE status = 'pending' AND product_id IS NOT NULL
         GROUP BY product_id`
      )
      .all() as unknown as Array<{ product_id: string; n: number; edited: number }>
    for (const d of drafts) draftMap.set(d.product_id, { count: Number(d.n), edited: Number(d.edited) === 1 })
  } catch {
    /* 表还没建好 */
  }

  // 生成图第一张当缩略图（和流水线页同一套来源，避免重复实现）
  const firstImage = new Map<string, string>()
  try {
    const imgs = db
      .prepare('SELECT product_id, file FROM product_images ORDER BY slot ASC, created_at ASC')
      .all() as unknown as Array<{ product_id: string; file: string }>
    for (const i of imgs) if (!firstImage.has(i.product_id)) firstImage.set(i.product_id, i.file)
  } catch {
    /* 表还没建好 */
  }

  return rows.map((r) => {
    const rec = specsMap.get(r.id)
    let listingCategory = ''
    if (r.listing) {
      try {
        listingCategory = String((JSON.parse(r.listing) as { category?: string }).category ?? '')
      } catch {
        listingCategory = ''
      }
    }
    const file = firstImage.get(r.id)
    // 原始资料指纹：和提取时记的对比，就知道结构化结果过没过期（不读大字段）
    const hash = specsSourceHash({
      sourceTitle: r.source_title ?? '',
      sourceUrl: '',
      description: r.description ?? '',
      sourceKeywords: [],
      amazonTitle: '',
      priceCny: 0,
      priceMaxCny: null,
      moq: 0,
      supplier: '',
      altSuppliers: '',
      materialCn: r.material_cn ?? '',
      colorsCn: r.colors_cn ?? '',
      sizeCn: r.size_cn ?? '',
      weightG: r.weight_g,
      cartonLCm: r.carton_l_cm,
      cartonWCm: r.carton_w_cm,
      cartonHCm: r.carton_h_cm,
      pcsPerCarton: r.pcs_per_carton,
      cartonGwKg: r.carton_gw_kg,
      images: [],
      category: r.category ?? '',
      notes: r.notes ?? '',
    })
    return {
      productId: r.id,
      code: r.code || '',
      title: r.source_title || '',
      category: r.category || String(r.eval_category ?? '') || listingCategory,
      status: r.status,
      hasListing: Boolean(r.listing),
      updatedAt: r.updated_at,
      thumb: file ? `/api/product-images/${r.id}/${file}` : '',
      thumbFallback:
        !file && r.has_src_images ? `/api/flow/thumb/${r.id}?v=${encodeURIComponent(r.updated_at)}` : '',
      pendingDraft: draftMap.get(r.id) ?? { count: 0, edited: false },
      specs: {
        filled: rec?.filled ?? 0,
        total: rec?.total ?? SPEC_KEYS.length,
        unknownFields: rec?.unknownFields ?? [...SPEC_KEYS],
        extractedAt: rec?.extractedAt ?? null,
        editedAt: rec?.editedAt ?? null,
        stale: Boolean(rec?.sourceHash) && rec?.sourceHash !== hash,
      },
    }
  })
}

/** 卡片列表 + 筛选（筛选放后端做，前端只管展示） */
productSpecsRouter.get('/cards', (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim().toLowerCase()
  const category = String(req.query.category ?? '').trim()
  const filter = String(req.query.filter ?? 'all')

  let cards = listProductCards()
  if (q) {
    cards = cards.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
    )
  }
  if (category) cards = cards.filter((c) => c.category === category)

  const categories = Array.from(new Set(cards.map((c) => c.category).filter(Boolean))).sort()
  const counts = {
    all: cards.length,
    done: cards.filter((c) => c.specs.filled === c.specs.total).length,
    missing: cards.filter((c) => c.specs.filled < c.specs.total).length,
    none: cards.filter((c) => !c.specs.extractedAt && !c.specs.editedAt).length,
  }

  if (filter === 'done') cards = cards.filter((c) => c.specs.filled === c.specs.total)
  else if (filter === 'missing') cards = cards.filter((c) => c.specs.filled < c.specs.total)
  else if (filter === 'none') cards = cards.filter((c) => !c.specs.extractedAt && !c.specs.editedAt)

  res.json({ cards, categories, counts, fields: SPEC_FIELDS })
})

/** 单条详情：结构化资料 + 原始资料摘要（并排看，才知道 AI 有没有读错） */
productSpecsRouter.get('/:productId', (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  const product = findProduct(productId)
  const record = getSpecRecord(productId)
  res.json({
    productId,
    code: product.code,
    title: product.source.sourceTitle,
    sourceUrl: product.source.sourceUrl,
    status: product.status,
    category: product.source.category,
    hasListing: Boolean(product.listing),
    record: record ?? {
      productId,
      specs: emptySpecs(),
      unknownFields: [...SPEC_KEYS],
      filled: 0,
      total: SPEC_KEYS.length,
      model: '',
      extractedAt: null,
      editedAt: null,
      updatedAt: '',
    },
    stale: specsStale(productId, product.source),
    /** 原始资料：只用来核对，不允许在这里改（改原文走产品详情） */
    source: {
      title: product.source.sourceTitle,
      description: product.source.description,
      materialCn: product.source.materialCn,
      colorsCn: product.source.colorsCn,
      sizeCn: product.source.sizeCn,
      weightG: product.source.weightG,
      carton: [product.source.cartonLCm, product.source.cartonWCm, product.source.cartonHCm],
      pcsPerCarton: product.source.pcsPerCarton,
      cartonGwKg: product.source.cartonGwKg,
      notes: product.source.notes,
    },
    fields: SPEC_FIELDS,
  })
})

/** 单条提取（同步）：用户点「重新提取」，等十几秒直接看到结果 */
productSpecsRouter.post('/:productId/extract', async (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  const product = findProduct(productId)
  const settings = loadSettings()
  if (!settings.aiApiKey?.trim()) {
    throw new AppError(400, '还没配置 AI Key，无法提取。可以到「设置」填 Key，或直接在信息卡里手工填。')
  }
  // keepManual=true（默认）：本次只填「未知」的字段，人工已经改过的值不覆盖
  const keepManual = String(req.query.keepManual ?? '1') !== '0'

  const result = await extractSpecs(product.source, settings, productId)
  const existing = getSpecRecord(productId)
  const merged = { ...result.specs }
  if (keepManual && existing) {
    // 只保留「AI 这次没提出来、但人工填过」的字段：
    // 用户主动点重新提取时，AI 提出来的事实应该覆盖旧值，否则永远修不对。
    for (const key of SPEC_KEYS) {
      const prev = existing.specs[key]
      const prevKnown = normalizeSpecs({ [key]: prev }).unknownFields.length === 0
      if (prevKnown && result.specs[key] === UNKNOWN) merged[key] = prev
    }
  }
  const record = saveSpecs(productId, merged, {
    model: result.model,
    sourceHash: specsSourceHash(product.source),
    extracted: true,
  })
  res.json({ record, filled: record.filled, fields: SPEC_FIELDS })
})

const patchSchema = z.object({
  specs: z.record(z.string().max(600)),
})

/** 人工修改：只接受 14 个字段，多余键丢弃；空值一律落成 Unknown */
productSpecsRouter.patch('/:productId', (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  findProduct(productId)
  const body = patchSchema.parse(req.body ?? {})
  const existing = getSpecRecord(productId)
  const base: ProductSpecs = existing?.specs ?? emptySpecs()
  const next = { ...base }
  for (const key of SPEC_KEYS) {
    if (key in body.specs) next[key] = String(body.specs[key] ?? '')
  }
  const record = saveSpecs(productId, next, { edited: true })
  res.json({ record })
})

/** 原始资料被改了 → 提示「结构化结果可能过期」（不自动覆盖，用户自己决定） */
productSpecsRouter.get('/:productId/stale', (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  const product = findProduct(productId)
  res.json({ stale: specsStale(productId, product.source) })
})

export type { ProductSpecRecord }
