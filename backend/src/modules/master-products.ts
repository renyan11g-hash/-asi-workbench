/**
 * 产品资料库（自建主数据）。
 *
 * 目的：同一条 1688 链接的箱规、每箱数、箱毛重、图片这些「抓不到 / 只想知道一次」的资料，
 * 手工录一次进这里，之后无论单品预填还是批量处理，抓取时直接命中，不用再重复补。
 *
 * 命中优先级：资料库 > 1688 在线抓取（资料库是人工核对过的，比反爬抓回来的可信）。
 */

import { randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'

export interface MasterProduct {
  id: string
  offerId: string | null
  sourceUrl: string
  title: string
  priceCny: number | null
  sizeCn: string
  weightG: number | null
  cartonLCm: number | null
  cartonWCm: number | null
  cartonHCm: number | null
  pcsPerCarton: number | null
  cartonGwKg: number | null
  images: string[]
  notes: string
  supplier: string
  materialCn: string
  colorsCn: string
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  offer_id: string | null
  source_url: string
  title: string
  price_cny: number | null
  size_cn: string
  weight_g: number | null
  carton_l_cm: number | null
  carton_w_cm: number | null
  carton_h_cm: number | null
  pcs_per_carton: number | null
  carton_gw_kg: number | null
  images: string
  notes: string
  supplier: string
  material_cn: string
  colors_cn: string
  created_at: string
  updated_at: string
}

function parseImages(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as unknown[]).map((x) => String(x ?? '')).filter(Boolean) : []
  } catch {
    return []
  }
}

function rowToMaster(r: Row): MasterProduct {
  return {
    id: r.id,
    offerId: r.offer_id,
    sourceUrl: r.source_url,
    title: r.title,
    priceCny: r.price_cny,
    sizeCn: r.size_cn,
    weightG: r.weight_g,
    cartonLCm: r.carton_l_cm,
    cartonWCm: r.carton_w_cm,
    cartonHCm: r.carton_h_cm,
    pcsPerCarton: r.pcs_per_carton,
    cartonGwKg: r.carton_gw_kg,
    images: parseImages(r.images),
    notes: r.notes,
    supplier: r.supplier,
    materialCn: r.material_cn,
    colorsCn: r.colors_cn,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 从任意 1688 链接里取 offerId（没有就返回空） */
export function offerIdOf(url: string): string {
  return (url ?? '').match(/offer\/(\d{6,})/)?.[1] ?? ''
}

/** 按链接查资料库：offerId 优先，其次原始 URL 精确匹配 */
export function findMasterByUrl(url: string): MasterProduct | null {
  const clean = (url ?? '').trim()
  if (!clean) return null
  const offerId = offerIdOf(clean)
  if (offerId) {
    const byOffer = db.prepare('SELECT * FROM master_products WHERE offer_id = ?').get(offerId) as
      | unknown as Row
      | undefined
    const row = byOffer as Row | undefined
    if (row) return rowToMaster(row)
  }
  const byUrl = db.prepare('SELECT * FROM master_products WHERE source_url = ?').get(clean) as
    | unknown as Row
    | undefined
  const row = byUrl as Row | undefined
  return row ? rowToMaster(row) : null
}

const masterSchema = z.object({
  sourceUrl: z.string().max(2000).default(''),
  title: z.string().max(500).default(''),
  priceCny: z.coerce.number().nullable().optional(),
  sizeCn: z.string().max(200).default(''),
  weightG: z.coerce.number().nullable().optional(),
  cartonLCm: z.coerce.number().nullable().optional(),
  cartonWCm: z.coerce.number().nullable().optional(),
  cartonHCm: z.coerce.number().nullable().optional(),
  pcsPerCarton: z.coerce.number().nullable().optional(),
  cartonGwKg: z.coerce.number().nullable().optional(),
  images: z.array(z.string().max(4000)).max(20).default([]),
  notes: z.string().max(2000).default(''),
  supplier: z.string().max(200).default(''),
  materialCn: z.string().max(200).default(''),
  colorsCn: z.string().max(200).default(''),
})

type MasterInput = z.infer<typeof masterSchema>

function insertMaster(input: MasterInput): string {
  const now = new Date().toISOString()
  const id = randomUUID()
  const offerId = offerIdOf(input.sourceUrl) || null
  db.prepare(
    `INSERT INTO master_products (id, offer_id, source_url, title, price_cny, size_cn, weight_g,
      carton_l_cm, carton_w_cm, carton_h_cm, pcs_per_carton, carton_gw_kg, images, notes,
      supplier, material_cn, colors_cn, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    offerId,
    input.sourceUrl,
    input.title,
    input.priceCny ?? null,
    input.sizeCn,
    input.weightG ?? null,
    input.cartonLCm ?? null,
    input.cartonWCm ?? null,
    input.cartonHCm ?? null,
    input.pcsPerCarton ?? null,
    input.cartonGwKg ?? null,
    JSON.stringify(input.images ?? []),
    input.notes,
    input.supplier,
    input.materialCn,
    input.colorsCn,
    now,
    now
  )
  return id
}

function updateMaster(id: string, input: MasterInput): void {
  db.prepare(
    `UPDATE master_products SET offer_id=?, source_url=?, title=?, price_cny=?, size_cn=?, weight_g=?,
      carton_l_cm=?, carton_w_cm=?, carton_h_cm=?, pcs_per_carton=?, carton_gw_kg=?, images=?, notes=?,
      supplier=?, material_cn=?, colors_cn=?, updated_at=? WHERE id=?`
  ).run(
    offerIdOf(input.sourceUrl) || null,
    input.sourceUrl,
    input.title,
    input.priceCny ?? null,
    input.sizeCn,
    input.weightG ?? null,
    input.cartonLCm ?? null,
    input.cartonWCm ?? null,
    input.cartonHCm ?? null,
    input.pcsPerCarton ?? null,
    input.cartonGwKg ?? null,
    JSON.stringify(input.images ?? []),
    input.notes,
    input.supplier,
    input.materialCn,
    input.colorsCn,
    new Date().toISOString(),
    id
  )
}

export const masterProductsRouter: Router = Router()

/** 列表 / 搜索 */
masterProductsRouter.get('/', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim()
  const rows = (
    q
      ? db
          .prepare(
            'SELECT * FROM master_products WHERE title LIKE ? OR source_url LIKE ? OR notes LIKE ? OR material_cn LIKE ? ORDER BY updated_at DESC LIMIT 500'
          )
          .all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
      : db.prepare('SELECT * FROM master_products ORDER BY updated_at DESC LIMIT 500').all()
  ) as unknown as Row[]
  res.json({ products: rows.map(rowToMaster) })
})

/** 按链接查（前端粘贴链接时先问一句，命中就直接填） */
masterProductsRouter.get('/lookup', async (req: Request, res: Response) => {
  const url = String(req.query.url ?? '').trim()
  const found = findMasterByUrl(url)
  res.json({ found })
})

/** 新增（同一条链接已存在时改为更新，避免重复录） */
masterProductsRouter.post('/', async (req: Request, res: Response) => {
  const body = masterSchema.parse(req.body ?? {})
  const existing = findMasterByUrl(body.sourceUrl)
  if (existing) {
    updateMaster(existing.id, body)
    res.json({ product: findMasterByUrl(body.sourceUrl), updated: true })
    return
  }
  const id = insertMaster(body)
  const row = db.prepare('SELECT * FROM master_products WHERE id = ?').get(id) as unknown as Row
  res.status(201).json({ product: rowToMaster(row), updated: false })
})

masterProductsRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const row = db.prepare('SELECT * FROM master_products WHERE id = ?').get(id) as unknown as Row | undefined
  if (!row) throw new AppError(404, '资料不存在')
  const current = rowToMaster(row)
  const body = masterSchema.parse({ ...current, ...(req.body ?? {}) })
  updateMaster(id, body)
  const next = db.prepare('SELECT * FROM master_products WHERE id = ?').get(id) as unknown as Row
  res.json({ product: rowToMaster(next) })
})

masterProductsRouter.delete('/:id', async (req: Request, res: Response) => {
  db.prepare('DELETE FROM master_products WHERE id = ?').run(String(req.params.id))
  res.json({ ok: true })
})
