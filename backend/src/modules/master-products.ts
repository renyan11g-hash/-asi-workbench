/**
 * 产品资料库（自建主数据）。
 *
 * 目的：同一条 1688 链接的箱规、每箱数、箱毛重、图片这些「抓不到 / 只想知道一次」的资料，
 * 手工录一次进这里，之后无论单品预填还是批量处理，抓取时直接命中，不用再重复补。
 *
 * 命中优先级：资料库 > 1688 在线抓取（资料库是人工核对过的，比反爬抓回来的可信）。
 */

import { randomUUID } from 'crypto'
import ExcelJS from 'exceljs'
import iconv from 'iconv-lite'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { dispImgIds, extractWpsCellImages } from '../services/cell-images'
import { buildPriceGrid, convertUnits } from '../services/pricing'
import { detectColors, detectMaterial, detectMaterials, translateColors } from '../constants/asi'
import { runListingQc } from '../services/listing-qc'
import { SPEC_KEYS, cleanValue, isKnown, specsSourceHash } from '../services/spec-fields'
import { createTask, runTask, updateTask } from '../services/task-manager'
import type { Listing, PriceRow, SourceInfo } from '../types'
import { insertProduct } from './products'
import { loadSettings } from './settings'

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
  /** 备选供应商：一个或多个，每行一个（主供应商断货/涨价时用来替换） */
  altSuppliers: string
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
  alt_suppliers: string
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
    altSuppliers: r.alt_suppliers ?? '',
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
  // 图片数量不限（用户可能从 1688 存几十张多角度图）；只留一个防滥用的硬上限 300 张，
  // 单条 URL 仍限长 4000，避免把整段 base64 塞进来。
  images: z.array(z.string().max(4000)).max(300).default([]),
  notes: z.string().max(2000).default(''),
  supplier: z.string().max(200).default(''),
  /** 备选供应商：每行一个（允许多个），也兼容逗号/顿号分隔 */
  altSuppliers: z.string().max(4000).default(''),
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
      supplier, alt_suppliers, material_cn, colors_cn, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    input.altSuppliers ?? '',
    input.materialCn,
    input.colorsCn,
    now,
    now
  )
  // 新建的资料如果已经有产品档案（先建档案、后录资料），也要同步过去
  syncMasterToProductsById(id)
  return id
}

function updateMaster(id: string, input: MasterInput): MasterSyncResult {
  db.prepare(
    `UPDATE master_products SET offer_id=?, source_url=?, title=?, price_cny=?, size_cn=?, weight_g=?,
      carton_l_cm=?, carton_w_cm=?, carton_h_cm=?, pcs_per_carton=?, carton_gw_kg=?, images=?, notes=?,
      supplier=?, alt_suppliers=?, material_cn=?, colors_cn=?, updated_at=? WHERE id=?`
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
    input.altSuppliers ?? '',
    input.materialCn,
    input.colorsCn,
    new Date().toISOString(),
    id
  )
  return syncMasterToProductsById(id)
}

export interface MasterSyncResult {
  /** 联动更新的产品档案条数 */
  synced: number
  /** 其中重算了阶梯价格表的条数（产品文案 / 待审核文案） */
  repriced: number
}

interface LinkedProductRow {
  id: string
  source_title: string | null
  source_url: string | null
  description: string | null
  category: string | null
  notes: string | null
  images: string | null
  price_cny: number | null
  size_cn: string | null
  weight_g: number | null
  carton_l_cm: number | null
  carton_w_cm: number | null
  carton_h_cm: number | null
  pcs_per_carton: number | null
  carton_gw_kg: number | null
  material_cn: string | null
  colors_cn: string | null
  supplier: string | null
  alt_suppliers: string | null
  listing: string | null
}

interface MergedLinked {
  sourceTitle: string
  sourceUrl: string
  notes: string
  images: string[]
  priceCny: number | null
  sizeCn: string
  weightG: number | null
  cartonLCm: number | null
  cartonWCm: number | null
  cartonHCm: number | null
  pcsPerCarton: number | null
  cartonGwKg: number | null
  materialCn: string
  colorsCn: string
  supplier: string
  altSuppliers: string
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  try {
    return text ? (JSON.parse(text) as T) : fallback
  } catch {
    return fallback
  }
}

/**
 * 资料库是主数据：只要字段有值就覆盖产品档案；空值保留产品原有数据。
 * 标题 / 链接 / 备注 / 图片也一起同步（以前只同步价格箱规，导致改了标题图片后产品页还是老的）。
 */
function mergeLinked(m: MasterProduct, r: LinkedProductRow): MergedLinked {
  const text = (v: string | null | undefined, old: string | null) =>
    (v ?? '').trim() ? (v as string) : old ?? ''
  const oldImages = parseJson<string[]>(r.images, [])
  return {
    sourceTitle: text(m.title, r.source_title),
    sourceUrl: text(m.sourceUrl, r.source_url),
    notes: text(m.notes, r.notes),
    images: m.images?.length ? m.images : oldImages,
    priceCny: m.priceCny ?? r.price_cny,
    sizeCn: text(m.sizeCn, r.size_cn),
    weightG: m.weightG ?? r.weight_g,
    cartonLCm: m.cartonLCm ?? r.carton_l_cm,
    cartonWCm: m.cartonWCm ?? r.carton_w_cm,
    cartonHCm: m.cartonHCm ?? r.carton_h_cm,
    pcsPerCarton: m.pcsPerCarton ?? r.pcs_per_carton,
    cartonGwKg: m.cartonGwKg ?? r.carton_gw_kg,
    materialCn: text(m.materialCn, r.material_cn),
    colorsCn: text(m.colorsCn, r.colors_cn),
    supplier: text(m.supplier, r.supplier),
    altSuppliers: text(m.altSuppliers, r.alt_suppliers),
  }
}

/** 同步后的完整 SourceInfo（Listing / 结构化资料 / 评估草稿都按它重算） */
function sourceOfLinked(r: LinkedProductRow, next: MergedLinked): SourceInfo {
  return {
    sourceTitle: next.sourceTitle,
    sourceUrl: next.sourceUrl,
    description: r.description ?? '',
    sourceKeywords: [],
    amazonTitle: '',
    priceCny: next.priceCny ?? 0,
    priceMaxCny: null,
    moq: 0,
    supplier: next.supplier,
    altSuppliers: next.altSuppliers,
    materialCn: next.materialCn,
    colorsCn: next.colorsCn,
    sizeCn: next.sizeCn,
    weightG: next.weightG,
    cartonLCm: next.cartonLCm,
    cartonWCm: next.cartonWCm,
    cartonHCm: next.cartonHCm,
    pcsPerCarton: next.pcsPerCarton,
    cartonGwKg: next.cartonGwKg,
    images: next.images,
    category: r.category ?? '',
    notes: next.notes,
  }
}

interface ListingSyncFlags {
  costChanged: boolean
  materialChanged: boolean
  cartonChanged: boolean
  now: string
}

function appendWarning(listing: Record<string, unknown>, text: string): void {
  const warnings = Array.isArray(listing.warnings) ? (listing.warnings as unknown[]).map(String) : []
  if (!warnings.includes(text)) warnings.push(text)
  listing.warnings = warnings
}

/** 包装描述里那段外箱信息是可确定的，跟着箱规一起改；改不动就留原文并提示复核 */
function syncPackaging(oldText: string, src: SourceInfo): string {
  const text = String(oldText ?? '').trim()
  if (!text) return text
  if (!src.pcsPerCarton || !src.cartonLCm || !src.cartonWCm || !src.cartonHCm || !src.cartonGwKg) return text
  const sentence = `${src.pcsPerCarton} pcs per carton, ${src.cartonLCm} x ${src.cartonWCm} x ${src.cartonHCm} cm, ${src.cartonGwKg} kg per carton`
  const pattern =
    /\d+\s*pcs per carton,\s*[\d.?]+\s*x\s*[\d.?]+\s*x\s*[\d.?]+\s*cm,\s*[\d.]+\s*kg per carton/i
  return pattern.test(text) ? text.replace(pattern, sentence) : text
}

/**
 * 一份 Listing 文本 → 用最新资料重算所有「可确定字段」：
 * 尺寸/重量/箱规/颜色/材质/包装里的箱规。价格表在成本变化时按原档位重算（保留人工倍率/运输方式）。
 * 文案措辞（标题/描述里的材质说法）无法安全字符串替换，材质变了会加一条英文 warning 提醒重新生成。
 */
function syncListingFields(
  text: string | null,
  src: SourceInfo,
  flags: ListingSyncFlags
): { text: string; rows: PriceRow[] | null } | null {
  if (!text) return null
  let listing: Record<string, unknown>
  try {
    listing = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  const units = convertUnits(src)
  const next: Record<string, unknown> = {
    ...listing,
    productSizeInch: units.productSizeInch,
    productSizeCm: units.productSizeCm,
    unitWeightLb: units.unitWeightLb,
    cartonSizeInch: units.cartonSizeInch,
    cartonGwLb: units.cartonGwLb,
  }
  if (src.colorsCn.trim()) {
    const colors = translateColors(src.colorsCn)
    if (colors) {
      next.colors = colors
      next.colorChips = detectColors(src.colorsCn)
    }
  }
  if (src.materialCn.trim()) {
    next.material = detectMaterial(src.materialCn)
    next.materials = detectMaterials(src.materialCn)
  }
  if (flags.cartonChanged) next.packaging = syncPackaging(String(listing.packaging ?? ''), src)
  if (flags.materialChanged) {
    appendWarning(
      next,
      `Source material changed on ${flags.now.slice(0, 10)}; regenerate the English copy if the title or description names the material.`
    )
  }

  let rows: PriceRow[] | null = null
  if (flags.costChanged) {
    const re = repriceListingText(JSON.stringify(next), src)
    if (re) {
      try {
        Object.assign(next, JSON.parse(re.text) as Record<string, unknown>)
        rows = re.rows
      } catch {
        /* 价格表重算失败就保留原表 */
      }
    }
  }
  return { text: JSON.stringify(next), rows }
}

/** 结构化资料（14 项）里与资料库重叠的字段一起改；其余字段保留原值 */
function syncProductSpecs(productId: string, src: SourceInfo, now: string): boolean {
  const row = db.prepare('SELECT data FROM product_specs WHERE product_id = ?').get(productId) as unknown as
    | { data: string }
    | undefined
  if (!row) return false
  const data = parseJson<Record<string, unknown>>(row.data, {})
  const set = (key: string, value: unknown) => {
    const s = String(value ?? '').trim()
    if (s) data[key] = cleanValue(s)
  }
  set('productName', src.sourceTitle)
  set('material', src.materialCn)
  set('productSize', src.sizeCn)
  set('productWeight', src.weightG ? `${src.weightG}g` : '')
  set('colors', src.colorsCn)
  if (src.cartonLCm && src.cartonWCm && src.cartonHCm) {
    set('cartonDimensions', `${src.cartonLCm} x ${src.cartonWCm} x ${src.cartonHCm} cm`)
  }
  set('unitsPerCarton', src.pcsPerCarton)
  set('cartonGrossWeight', src.cartonGwKg ? `${src.cartonGwKg}kg` : '')
  const unknown = SPEC_KEYS.filter((k) => !isKnown(data[k]))
  db.prepare(
    `UPDATE product_specs SET data = ?, unknown_fields = ?, source_hash = ?, updated_at = ? WHERE product_id = ?`
  ).run(JSON.stringify(data), JSON.stringify(unknown), specsSourceHash(src), now, productId)
  return true
}

/** 评估库草稿里也存了一份 source 快照，一起换成最新资料 */
function syncEvalDraft(productId: string, source: SourceInfo, now: string): boolean {
  const row = db.prepare('SELECT draft_id FROM products WHERE id = ?').get(productId) as unknown as
    | { draft_id: string | null }
    | undefined
  if (!row?.draft_id) return false
  const draft = db.prepare('SELECT content FROM drafts WHERE id = ?').get(row.draft_id) as unknown as
    | { content: string }
    | undefined
  if (!draft) return false
  const content = parseJson<Record<string, unknown>>(draft.content, {})
  content.source = source
  db.prepare('UPDATE drafts SET title = ?, content = ?, updated_at = ? WHERE id = ?').run(
    source.sourceTitle.slice(0, 200) || '未命名产品',
    JSON.stringify(content),
    now,
    row.draft_id
  )
  return true
}

/** 待审核版本的 source / 标题 / 链接 / 图片也换成本次同步后的资料 */
function mergeReviewSource(
  sourceText: string,
  next: MergedLinked,
  source: SourceInfo
): string {
  const src = parseJson<Record<string, unknown>>(sourceText, {})
  return JSON.stringify({
    ...src,
    sourceTitle: source.sourceTitle,
    sourceUrl: source.sourceUrl,
    description: src.description ?? source.description,
    priceCny: next.priceCny ?? 0,
    sizeCn: next.sizeCn,
    weightG: next.weightG,
    cartonLCm: next.cartonLCm,
    cartonWCm: next.cartonWCm,
    cartonHCm: next.cartonHCm,
    pcsPerCarton: next.pcsPerCarton,
    cartonGwKg: next.cartonGwKg,
    materialCn: next.materialCn,
    colorsCn: next.colorsCn,
    supplier: next.supplier,
    altSuppliers: next.altSuppliers,
    notes: next.notes,
    images: next.images,
    category: src.category ?? source.category,
  })
}

/**
 * 资料库改价后重算阶梯价格表。
 * 保留人工调过的三样东西：每一档的空运/海运、倍率、数量；只让采购价/箱规的变化反映到售价与毛利上。
 */
function repriceListingText(
  listingText: string | null,
  src: Pick<
    SourceInfo,
    'priceCny' | 'weightG' | 'cartonLCm' | 'cartonWCm' | 'cartonHCm' | 'pcsPerCarton' | 'cartonGwKg'
  >
): { text: string; rows: PriceRow[] } | null {
  if (!listingText) return null
  let listing: Record<string, unknown>
  try {
    listing = JSON.parse(listingText) as Record<string, unknown>
  } catch {
    return null
  }
  const oldRows = ((listing.priceGrid as PriceRow[] | undefined) ?? []).filter(Boolean)
  if (!oldRows.length) return null
  try {
    const { rows } = buildPriceGrid(src, loadSettings(), {
      shippingModes: oldRows.map((r) => (r.shipping === 'sea' ? ('sea' as const) : ('air' as const))),
      markupByIndex: Object.fromEntries(oldRows.map((r, i) => [i, Number(r.markupRate) || 0])),
      qtyLevels: oldRows.every((r) => Number(r.qty) > 0) ? oldRows.map((r) => Number(r.qty)) : null,
    })
    if (!rows.length) return null
    return { text: JSON.stringify({ ...listing, priceGrid: rows }), rows }
  } catch {
    return null
  }
}

/**
 * 资料库 → 产品档案（全字段联动）。
 *
 * 资料库是主数据：产品档案、结构化资料、评估草稿、已保存的英文链接、待审核文案里
 * 凡是「抄了一份」的资料，都在这里一起更新。可确定字段（价格/尺寸/重量/箱规/颜色/材质/
 * 包装里的箱规）直接重算；AI 写的文案措辞无法安全替换，材质变了会加一条 warning 提醒重新生成。
 */
export function syncMasterToProducts(m: MasterProduct): MasterSyncResult {
  const out: MasterSyncResult = { synced: 0, repriced: 0 }
  let rows: LinkedProductRow[]
  try {
    const sql = `SELECT id, source_title, source_url, description, category, notes, images,
                        price_cny, size_cn, weight_g, carton_l_cm, carton_w_cm, carton_h_cm,
                        pcs_per_carton, carton_gw_kg, material_cn, colors_cn, supplier, alt_suppliers, listing
                   FROM products
                  WHERE master_id = ?${m.sourceUrl ? " OR (source_url <> '' AND source_url = ?)" : ''}`
    rows = (m.sourceUrl
      ? db.prepare(sql).all(m.id, m.sourceUrl)
      : db.prepare(sql).all(m.id)) as unknown as LinkedProductRow[]
  } catch {
    return out
  }

  const now = new Date().toISOString()
  for (const r of rows) {
    const next = mergeLinked(m, r)
    const numChanged = (a: number | null, b: number | null | undefined) => Number(a ?? 0) !== Number(b ?? 0)
    const strChanged = (a: string | null | undefined, b: string | null | undefined) =>
      (a ?? '').trim() !== (b ?? '').trim()

    const costChanged =
      numChanged(r.price_cny, next.priceCny) ||
      numChanged(r.weight_g, next.weightG) ||
      numChanged(r.carton_gw_kg, next.cartonGwKg)
    const cartonChanged =
      numChanged(r.carton_l_cm, next.cartonLCm) ||
      numChanged(r.carton_w_cm, next.cartonWCm) ||
      numChanged(r.carton_h_cm, next.cartonHCm) ||
      numChanged(r.pcs_per_carton, next.pcsPerCarton)
    const materialChanged = strChanged(r.material_cn, next.materialCn)
    const colorsChanged = strChanged(r.colors_cn, next.colorsCn)
    const sizeChanged = strChanged(r.size_cn, next.sizeCn)
    const titleChanged = strChanged(r.source_title, next.sourceTitle)
    const urlChanged = strChanged(r.source_url, next.sourceUrl)
    const notesChanged = strChanged(r.notes, next.notes)
    const imagesChanged = JSON.stringify(parseJson<string[]>(r.images, [])) !== JSON.stringify(next.images)
    const supplierChanged = strChanged(r.supplier, next.supplier)
    const specsChanged = materialChanged || colorsChanged || sizeChanged || costChanged || cartonChanged
    const anyChanged =
      specsChanged || titleChanged || urlChanged || notesChanged || imagesChanged || supplierChanged

    db.prepare(
      `UPDATE products SET source_title=?, source_url=?, notes=?, images=?,
         price_cny=?, size_cn=?, weight_g=?, carton_l_cm=?, carton_w_cm=?, carton_h_cm=?,
         pcs_per_carton=?, carton_gw_kg=?, material_cn=?, colors_cn=?, supplier=?, alt_suppliers=?, master_id=?, updated_at=?
       WHERE id=?`
    ).run(
      next.sourceTitle,
      next.sourceUrl,
      next.notes,
      JSON.stringify(next.images),
      next.priceCny ?? null,
      next.sizeCn,
      next.weightG ?? null,
      next.cartonLCm ?? null,
      next.cartonWCm ?? null,
      next.cartonHCm ?? null,
      next.pcsPerCarton ?? null,
      next.cartonGwKg ?? null,
      next.materialCn,
      next.colorsCn,
      next.supplier,
      next.altSuppliers,
      m.id,
      now,
      r.id
    )
    out.synced += 1
    if (!anyChanged) continue

    const src = sourceOfLinked(r, next)
    const flags: ListingSyncFlags = {
      costChanged: costChanged || cartonChanged,
      materialChanged,
      cartonChanged,
      now,
    }

    // ① 产品自己的英文链接（已保存的 / 已上架的）
    const listingSync = syncListingFields(r.listing, src, flags)
    if (listingSync) {
      db.prepare('UPDATE products SET listing=?, updated_at=? WHERE id=?').run(listingSync.text, now, r.id)
      if (flags.costChanged) out.repriced += 1
    }

    // ② 产品结构化资料（14 项里和资料库重叠的字段）
    syncProductSpecs(r.id, src, now)

    // ③ 评估库草稿里存的 source 快照
    syncEvalDraft(r.id, src, now)

    // ④ 所有审核记录（待审核 / 已通过 / 已驳回）的 source、标题、链接、缩略图和可确定字段
    try {
      const reviews = db
        .prepare(
          `SELECT id, listing, source, status, title, source_url, image
             FROM listing_reviews WHERE product_id = ?`
        )
        .all(r.id) as unknown as Array<{
        id: string
        listing: string
        source: string
        status: string
        title: string
        source_url: string
        image: string | null
      }>
      for (const rv of reviews) {
        const ls = syncListingFields(rv.listing, src, flags)
        let qcJson: string | null = null
        if (rv.status === 'pending' && ls) {
          try {
            qcJson = JSON.stringify(runListingQc({ listing: JSON.parse(ls.text) as unknown as Listing }))
          } catch {
            qcJson = null
          }
        }
        db.prepare(
          `UPDATE listing_reviews SET title=?, source_url=?, image=?, source=?, listing=?,
             price_grid=COALESCE(?, price_grid), qc=COALESCE(?, qc), updated_at=?
           WHERE id=?`
        ).run(
          next.sourceTitle || rv.title,
          next.sourceUrl || rv.source_url,
          imagesChanged ? (next.images[0] ?? null) : rv.image,
          mergeReviewSource(rv.source, next, src),
          ls?.text ?? rv.listing,
          ls?.rows ? JSON.stringify(ls.rows) : null,
          qcJson,
          now,
          rv.id
        )
        if (ls?.rows) out.repriced += 1
      }
    } catch {
      /* 审核表结构异常不影响产品档案同步 */
    }

    // ⑤ 影响报价/材质/尺寸的改动会让旧的评估结论失真：标记回「待评估」，
    //    旧评估内容仍保留（不删除），人工重新评估后会覆盖。
    if (specsChanged) {
      try {
        db.prepare(
          `UPDATE products SET eval_review='pending', eval_reviewed_at=NULL,
             review_note='资料库已更新，需重新评估', updated_at=? WHERE id=?`
        ).run(now, r.id)
      } catch {
        /* 老库没有这些列时忽略 */
      }
    }

    // ⑥ 产品图/标题/材质/颜色变了，之前缓存的「AI 识图 + 风格匹配」结果就过期了：
    //    清掉缓存，下次出图会按新资料重新识别（视觉风格配置本身不受影响）。
    if (titleChanged || imagesChanged || materialChanged || colorsChanged) {
      try {
        db.prepare('DELETE FROM product_visual_profiles WHERE product_id = ?').run(r.id)
      } catch {
        /* 表不存在时忽略 */
      }
    }
  }
  return out
}

function syncMasterToProductsById(id: string): MasterSyncResult {
  const row = db.prepare('SELECT * FROM master_products WHERE id = ?').get(id) as unknown as Row | undefined
  if (!row) return { synced: 0, repriced: 0 }
  return syncMasterToProducts(rowToMaster(row))
}

export const masterProductsRouter: Router = Router()

/**
 * 资料库 → 产品档案：资料库里的一条资料必须有对应的产品档案，否则导入完只停在资料库里，
 * 产品流水线上一片空白（这就是「导入后完全没反应」的根因）。
 *
 * 幂等：优先按 master_id 找，其次按 1688 链接找；找到就复用，不重复建档、不覆盖已有文案/评估。
 */
export function ensureProductFromMaster(m: MasterProduct): { productId: string; created: boolean } {
  const byMaster = db.prepare('SELECT id FROM products WHERE master_id = ?').get(m.id) as
    | { id: string }
    | undefined
  if (byMaster) return { productId: byMaster.id, created: false }

  if (m.sourceUrl) {
    const byUrl = db
      .prepare('SELECT id, master_id FROM products WHERE source_url = ? LIMIT 1')
      .get(m.sourceUrl) as { id: string; master_id: string | null } | undefined
    if (byUrl) {
      if (!byUrl.master_id) {
        db.prepare('UPDATE products SET master_id = ? WHERE id = ?').run(m.id, byUrl.id)
      }
      return { productId: byUrl.id, created: false }
    }
  }

  const source: SourceInfo = {
    sourceTitle: m.title,
    sourceUrl: m.sourceUrl,
    description: m.notes,
    sourceKeywords: [],
    amazonTitle: '',
    priceCny: m.priceCny ?? 0,
    priceMaxCny: null,
    moq: 0,
    supplier: m.supplier,
    altSuppliers: m.altSuppliers,
    materialCn: m.materialCn,
    colorsCn: m.colorsCn,
    sizeCn: m.sizeCn,
    weightG: m.weightG,
    cartonLCm: m.cartonLCm,
    cartonWCm: m.cartonWCm,
    cartonHCm: m.cartonHCm,
    pcsPerCarton: m.pcsPerCarton,
    cartonGwKg: m.cartonGwKg,
    // 资料库里的图就是出图参考图，一起带进产品档案
    images: m.images,
    category: '',
    notes: '',
  }
  const id = insertProduct({ source, evaluation: null, listing: null, status: 'sourced' })
  db.prepare('UPDATE products SET master_id = ? WHERE id = ?').run(m.id, id)
  return { productId: id, created: true }
}

/** 资料库里每条资料对应的产品档案（没有就是 null），列表里显示「已进入系统」 */
function linkedProducts(): Map<string, { id: string; code: string; status: string }> {
  const out = new Map<string, { id: string; code: string; status: string }>()
  try {
    const rows = db
      .prepare('SELECT master_id, id, code, status FROM products WHERE master_id IS NOT NULL')
      .all() as unknown as Array<{ master_id: string; id: string; code: string; status: string }>
    for (const r of rows) out.set(r.master_id, { id: r.id, code: r.code, status: r.status })
  } catch {
    /* ignore */
  }
  return out
}

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
  const linked = linkedProducts()
  res.json({
    products: rows.map((r) => {
      const m = rowToMaster(r)
      return { ...m, productId: linked.get(m.id)?.id ?? null, productCode: linked.get(m.id)?.code ?? null, productStatus: linked.get(m.id)?.status ?? null }
    }),
  })
})

/**
 * 推进到下一进程：把资料库里的资料变成产品档案（已在系统里的就复用）。
 * 前端勾选后一次调用，之后这些产品就出现在产品流水线上，可以批量评估。
 */
masterProductsRouter.post('/push', async (req: Request, res: Response) => {
  const body = z
    .object({ ids: z.array(z.string().min(1)).max(200).optional(), all: z.boolean().optional() })
    .parse(req.body ?? {})
  const rows = (
    body.all
      ? db.prepare('SELECT * FROM master_products ORDER BY updated_at DESC').all()
      : db
          .prepare(
            `SELECT * FROM master_products WHERE id IN (${(body.ids ?? ['']).map(() => '?').join(',')})`
          )
          .all(...(body.ids ?? []))
  ) as unknown as Row[]
  if (!rows.length) throw new AppError(400, '没有选中任何资料')

  const productIds: string[] = []
  let created = 0
  let existing = 0
  for (const r of rows) {
    try {
      const res2 = ensureProductFromMaster(rowToMaster(r))
      productIds.push(res2.productId)
      if (res2.created) created += 1
      else existing += 1
    } catch {
      /* 单条失败不影响其他条 */
    }
  }
  res.json({ ok: true, total: rows.length, created, existing, productIds })
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
    const sync = updateMaster(existing.id, body)
    res.json({
      product: findMasterByUrl(body.sourceUrl),
      updated: true,
      synced: sync.synced,
      repriced: sync.repriced,
    })
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
  const sync = updateMaster(id, body)
  const next = db.prepare('SELECT * FROM master_products WHERE id = ?').get(id) as unknown as Row
  res.json({
    product: rowToMaster(next),
    synced: sync.synced,
    repriced: sync.repriced,
  })
})

masterProductsRouter.delete('/:id', async (req: Request, res: Response) => {
  db.prepare('DELETE FROM master_products WHERE id = ?').run(String(req.params.id))
  res.json({ ok: true })
})

/** 批量删除（资料库里勾选后一次删掉，避免前端发几十个请求） */
masterProductsRouter.post('/bulk-delete', async (req: Request, res: Response) => {
  const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }).parse(req.body ?? {})
  const stmt = db.prepare('DELETE FROM master_products WHERE id = ?')
  let removed = 0
  for (const id of body.ids) removed += Number(stmt.run(id).changes ?? 0)
  res.json({ ok: true, removed })
})

// ---------------------------------------------------------------- 导入 / 导出

/** 导出/导入共用的列定义（顺序即表格列序） */
const COLUMNS: Array<{ key: keyof MasterProduct | 'imagesText'; label: string }> = [
  { key: 'sourceUrl', label: '1688链接' },
  { key: 'title', label: '商品名称' },
  { key: 'priceCny', label: '采购价(元)' },
  { key: 'sizeCn', label: '产品尺寸(cm)' },
  { key: 'weightG', label: '单个重量(g)' },
  { key: 'cartonLCm', label: '箱规长(cm)' },
  { key: 'cartonWCm', label: '箱规宽(cm)' },
  { key: 'cartonHCm', label: '箱规高(cm)' },
  { key: 'pcsPerCarton', label: '一箱数量' },
  { key: 'cartonGwKg', label: '一箱毛重(kg)' },
  { key: 'materialCn', label: '材质' },
  { key: 'colorsCn', label: '颜色' },
  { key: 'supplier', label: '供应商' },
  { key: 'altSuppliers', label: '备选供应商(多个换行)' },
  { key: 'notes', label: '备注' },
  { key: 'imagesText', label: '图片(多张换行)' },
]

function cellOf(m: MasterProduct, key: keyof MasterProduct | 'imagesText'): string | number {
  if (key === 'imagesText') return (m.images ?? []).join('\n')
  const v = m[key]
  if (v == null) return ''
  if (typeof v === 'number' || typeof v === 'string') return v
  return String(v)
}

/** 表头别名（导入时按名字找人话表头，中英文都认） */
type ColKey = keyof MasterProduct | 'imagesText' | 'cartonText'

const HEADER_ALIASES: Record<string, ColKey> = {
  '1688链接': 'sourceUrl',
  链接: 'sourceUrl',
  商品链接: 'sourceUrl',
  产品链接: 'sourceUrl',
  采购链接: 'sourceUrl',
  url: 'sourceUrl',
  商品名称: 'title',
  产品名称: 'title',
  名称: 'title',
  标题: 'title',
  品名: 'title',
  '采购价(元)': 'priceCny',
  采购价: 'priceCny',
  成本价: 'priceCny',
  进价: 'priceCny',
  价格: 'priceCny',
  '产品尺寸(cm)': 'sizeCn',
  产品尺寸: 'sizeCn',
  尺寸: 'sizeCn',
  '单个重量(g)': 'weightG',
  单个重量: 'weightG',
  单件重: 'weightG',
  '箱规长(cm)': 'cartonLCm',
  箱规长: 'cartonLCm',
  外箱长: 'cartonLCm',
  长: 'cartonLCm',
  '箱规宽(cm)': 'cartonWCm',
  箱规宽: 'cartonWCm',
  外箱宽: 'cartonWCm',
  宽: 'cartonWCm',
  '箱规高(cm)': 'cartonHCm',
  箱规高: 'cartonHCm',
  外箱高: 'cartonHCm',
  高: 'cartonHCm',
  一箱数量: 'pcsPerCarton',
  每箱数量: 'pcsPerCarton',
  装箱数: 'pcsPerCarton',
  装箱数量: 'pcsPerCarton',
  '一箱毛重(kg)': 'cartonGwKg',
  一箱毛重: 'cartonGwKg',
  箱毛重: 'cartonGwKg',
  整箱毛重: 'cartonGwKg',
  毛重: 'cartonGwKg',
  材质: 'materialCn',
  颜色: 'colorsCn',
  供应商: 'supplier',
  '备选供应商(多个换行)': 'altSuppliers',
  备选供应商: 'altSuppliers',
  备用供应商: 'altSuppliers',
  候选供应商: 'altSuppliers',
  供应商储备: 'altSuppliers',
  备选厂家: 'altSuppliers',
  备注: 'notes',
  '图片(多张换行)': 'imagesText',
  图片: 'imagesText',
  产品图: 'imagesText',
  商品主图: 'imagesText',
  主图: 'imagesText',
  // 下面这些是用户实际表格里常见的列名（带单位后缀会被 normHeader 去掉）
  商品尺寸: 'sizeCn',
  规格: 'sizeCn',
  单个产品重量: 'weightG',
  产品重量: 'weightG',
  净重: 'weightG',
  商品价格: 'priceCny',
  商品单价: 'priceCny',
  单价: 'priceCny',
  // 「箱规」一整列写成一串文字（如「50×40×40，一箱100个，毛重13kg」）
  箱规: 'cartonText',
  箱规尺寸: 'cartonText',
  外箱尺寸: 'cartonText',
  包装尺寸: 'cartonText',
  装箱规格: 'cartonText',
}

/** 表头归一：去空格、全角括号转半角、去掉 /cm、(cm)、/g 这类单位后缀 */
function normHeader(h: string): string {
  return String(h ?? '')
    .replace(/\s+/g, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[\/／]\s*(cm|mm|g|kg|元|个|pcs|inch|")$/i, '')
    .replace(/\((cm|mm|g|kg|元|个|pcs|inch|")\)$/i, '')
    .trim()
}

/** ok=是不是真实数据（排除 √ / ✓ / 是 这类勾选标记） */
function isMarker(v: string): boolean {
  return /^[√✓✔是Yy\-—]+$/.test(v.trim())
}

/** 表头 → 该字段可以取值的所有列下标（同一字段可能有多列，取第一个有真实数据的） */
function headerMap(header: string[]): Map<ColKey, number[]> {
  const map = new Map<ColKey, number[]>()
  header.forEach((h, i) => {
    const key = HEADER_ALIASES[normHeader(h)] as ColKey | undefined
    if (!key) return
    const list = map.get(key) ?? []
    list.push(i)
    map.set(key, list)
  })
  return map
}

/** 从「箱规」那串文字里拆出 长宽高 + 每箱数 + 毛重 */
export function parseCartonText(text: string): {
  L: number | null
  W: number | null
  H: number | null
  pcs: number | null
  gw: number | null
} {
  const t = String(text ?? '')
  const dims = t.match(/(\d+(?:\.\d+)?)\s*[x×*X*]\s*(\d+(?:\.\d+)?)\s*[x×*X*]\s*(\d+(?:\.\d+)?)/)
  // 「一箱100个」「每箱 80 个」「100pcs」
  const pcsM = t.match(/(?:一箱|每箱|装箱|箱装)?\s*(\d{1,6})\s*(?:个|只|pcs)/i)
  // 「毛重13kg」「21kg」「13 千克」
  const gwM = t.match(/(\d+(?:\.\d+)?)\s*(?:kg|千克|公斤)/i)
  return {
    L: dims ? Number(dims[1]) : null,
    W: dims ? Number(dims[2]) : null,
    H: dims ? Number(dims[3]) : null,
    pcs: pcsM ? Number(pcsM[1]) : null,
    gw: gwM ? Number(gwM[1]) : null,
  }
}

/** 把一行表格数据变成资料库输入；没有名称和链接就返回 null */
function rowToInput(map: Map<ColKey, number[]>, row: unknown[], cellImages?: Map<string, string>): MasterInput | null {
  /** 取该字段第一个「有真实数据」的单元格（跳过 √ 这类标记和空值） */
  const get = (k: ColKey): string => {
    for (const idx of map.get(k) ?? []) {
      const raw = row[idx]
      const v = raw == null ? '' : String(raw).trim()
      if (!v || isMarker(v)) continue
      return v
    }
    return ''
  }
  const numOf = (k: ColKey): number | null => {
    const t = get(k)
    if (!t) return null
    const n = Number(t.replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  const title = get('title')
  let sourceUrl = get('sourceUrl')
  // 链接列里塞的不是 1688 链接（常见：图片地址换行串行）就丢掉，避免导入一条空壳记录
  if (sourceUrl && !/1688\.com\//i.test(sourceUrl)) sourceUrl = ''
  if (!title && !sourceUrl) return null

  // 箱规：优先用「箱规长/宽/高」三列，没有就解析「箱规」那一串文字
  let cartonL = numOf('cartonLCm')
  let cartonW = numOf('cartonWCm')
  let cartonH = numOf('cartonHCm')
  let pcs = numOf('pcsPerCarton')
  let gw = numOf('cartonGwKg')
  const cartonTextCell = get('cartonText')
  if (cartonTextCell && (!cartonL || !pcs || !gw)) {
    const parsed = parseCartonText(cartonTextCell)
    cartonL = cartonL ?? parsed.L
    cartonW = cartonW ?? parsed.W
    cartonH = cartonH ?? parsed.H
    pcs = pcs ?? parsed.pcs
    gw = gw ?? parsed.gw
  }

  return {
    sourceUrl,
    title,
    priceCny: numOf('priceCny'),
    sizeCn: get('sizeCn'),
    weightG: numOf('weightG'),
    cartonLCm: cartonL,
    cartonWCm: cartonW,
    cartonHCm: cartonH,
    pcsPerCarton: pcs,
    cartonGwKg: gw,
    images: (() => {
      const raw = get('imagesText')
      // WPS 嵌入单元格图片：=DISPIMG("ID_xxx",1) → 从 xlsx 里解出来的 dataURL。
      // 这类图是整段 base64（一张几十 KB），一条记录塞太多会把库撑爆，仍限 8 张。
      const fromCell = dispImgIds(raw)
        .map((id) => cellImages?.get(id))
        .filter((u): u is string => Boolean(u))
      if (fromCell.length) return fromCell.slice(0, 8)
      // 普通图片网址：不限数量（多角度图越多，出图越不容易画错结构）
      return raw
        .split(/[\n\r|,，;；]+/)
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//i.test(s))
        .slice(0, 300)
    })(),
    notes: get('notes'),
    supplier: get('supplier'),
    altSuppliers: get('altSuppliers'),
    materialCn: get('materialCn'),
    colorsCn: get('colorsCn'),
  } as MasterInput
}

/** 导出 Excel */
masterProductsRouter.get('/export.xlsx', async (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM master_products ORDER BY updated_at DESC').all() as unknown as Row[]
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('产品资料库')
  ws.addRow(COLUMNS.map((c) => c.label))
  ws.getRow(1).font = { bold: true }
  for (const r of rows) {
    const m = rowToMaster(r)
    ws.addRow(COLUMNS.map((c) => cellOf(m, c.key)))
  }
  ws.columns.forEach((col, i) => {
    col.width = i === COLUMNS.length - 1 ? 40 : Math.max(10, COLUMNS[i].label.length * 2 + 4)
  })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', 'attachment; filename="master-products.xlsx"')
  const buf = await wb.xlsx.writeBuffer()
  res.send(Buffer.from(buf))
})

/** 导出 CSV（Excel 直接能打开） */
masterProductsRouter.get('/export.csv', async (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM master_products ORDER BY updated_at DESC').all() as unknown as Row[]
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [COLUMNS.map((c) => esc(c.label)).join(',')]
  for (const r of rows) {
    const m = rowToMaster(r)
    lines.push(COLUMNS.map((c) => esc(cellOf(m, c.key))).join(','))
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="master-products.csv"')
  res.send('\uFEFF' + lines.join('\n'))
})

/** 极简 CSV 解析（支持双引号包裹与 "" 转义） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else inQuotes = false
      } else cell += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/**
 * 导入：支持 .xlsx / .xls(另存为 xlsx) / .csv。
 * 前端把文件转成 base64 一起提交（不用 multer，避免多一个依赖）。
 * 按 1688 链接去重：已存在就更新，不存在就新增。
 */
masterProductsRouter.post('/import', async (req: Request, res: Response) => {
  const body = z
    .object({ filename: z.string().default('import.csv'), dataBase64: z.string().default('') })
    .parse(req.body ?? {})
  if (!body.dataBase64) {
    throw new AppError(400, '没有收到文件内容：请重新选文件（或文件是空的）')
  }
  let buf: Buffer
  try {
    buf = Buffer.from(body.dataBase64, 'base64')
  } catch {
    throw new AppError(400, '文件内容解码失败，请重新上传')
  }
  if (buf.length === 0) throw new AppError(400, '文件是空的')

  const isXlsxName = /\.xlsx$/i.test(body.filename)
  // xlsx 本质是 zip，头 4 字节是 PK\x03\x04。很多「xls 改名成 xlsx」在这里露馅，
  // 与其抛个看不懂的 500，不如直接说清楚。
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b

  let grid: string[][] = []
  try {
    if (isXlsxName) {
      if (!isZip) {
        throw new AppError(
          400,
          '这个文件不是真正的 .xlsx（可能是 .xls 改了扩展名，或 WPS/Numbers 导出的格式）。请用 Excel 打开后「另存为 → Excel 工作簿(*.xlsx)」，或另存为 .csv 再导入'
        )
      }
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(buf as unknown as ArrayBuffer)
      const ws = wb.worksheets[0]
      if (!ws) throw new AppError(400, 'Excel 里没有工作表')
      ws.eachRow((row) => {
        const values: string[] = []
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const v = cell.value
          let s = ''
          if (v == null) s = ''
          else if (typeof v === 'object' && v !== null && 'richText' in v) {
            const rt = (v as { richText: Array<{ text?: string }> }).richText
            s = Array.isArray(rt) ? rt.map((t) => t?.text ?? '').join('') : ''
          } else if (typeof v === 'object' && v !== null && 'text' in v) {
            s = String((v as { text: unknown }).text ?? '')
          } else if (typeof v === 'object' && v !== null && 'result' in v) {
            s = String((v as { result: unknown }).result ?? '')
          } else if (typeof v === 'object' && v !== null && 'hyperlink' in v) {
            s = String((v as { hyperlink: unknown }).hyperlink ?? '')
          } else s = String(v)
          values[colNumber - 1] = s
        })
        grid.push(values)
      })
    } else {
      // 中文版 Excel 另存 CSV 默认是 GBK/ANSI，直接按 UTF-8 读会全是乱码 → 表头认不出来。
      // 先按 UTF-8 解，出现替换字符（U+FFFD）就退回 GBK 再解一次。
      const utf8 = buf.toString('utf8').replace(/^\uFEFF/, '')
      const text = utf8.includes('\uFFFD') ? iconv.decode(buf, 'gbk').replace(/^\uFEFF/, '') : utf8
      grid = parseCsv(text)
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError(
      400,
      `解析文件失败：${err instanceof Error ? err.message : String(err)}（建议用 Excel 另存为 .xlsx 或 .csv 再试）`
    )
  }

  if (grid.length < 2) throw new AppError(400, '文件里没有数据行（第一行要是表头）')

  // 表头不一定在第一行（很多人表格上面还有标题行）：在前 10 行里找认出 ≥2 列的那一行
  let headerRow = -1
  let map = new Map<ColKey, number[]>()
  for (let i = 0; i < Math.min(10, grid.length); i++) {
    const m = headerMap(grid[i] ?? [])
    if (m.size >= 2) {      headerRow = i
      map = m
      break
    }
  }
  if (headerRow < 0) {
    const seen = (grid[0] ?? []).map((c) => String(c ?? '').trim()).filter(Boolean).slice(0, 6).join(' / ')
    throw new AppError(
      400,
      `没认出表头（前 10 行里没有至少 2 个能识别的列名）。读到的是：${seen || '（空表）'}。请点「导出 Excel」拿标准表头，至少要有「1688链接」和「商品名称」`
    )
  }

  let created = 0
  let updated = 0
  let skipped = 0
  let productsCreated = 0
  let productsLinked = 0
  const errors: Array<{ row: number; error: string }> = []

  // 记录哪些行有「嵌入单元格图片」，导入完成后交给后台任务慢慢解
  const pendingImages: Array<{ id: string; imgIds: string[] }> = []
  const imgCol = map.get('imagesText')?.[0]

  for (let i = headerRow + 1; i < grid.length; i++) {
    const row = grid[i] ?? []
    if (!row.some((c) => String(c ?? '').trim())) continue
    try {
      // 先不解析图片（解 38 张要几分钟，会把请求拖超时），先按文字入库
      const input = rowToInput(map, row)
      if (!input) {
        skipped += 1
        continue
      }
      const existing = input.sourceUrl ? findMasterByUrl(input.sourceUrl) : null
      if (existing) {
        updateMaster(existing.id, input)
        updated += 1
      } else {
        insertMaster(input)
        created += 1
      }
      // 导入即进入系统：顺手建/复用产品档案，产品流水线里立刻看得到这条
      try {
        const master = input.sourceUrl ? findMasterByUrl(input.sourceUrl) : null
        if (master) {
          const pushed = ensureProductFromMaster(master)
          if (pushed.created) productsCreated += 1
          else productsLinked += 1
        }
      } catch {
        /* 建档失败不影响资料入库本身 */
      }
      if (imgCol != null) {
        const ids = dispImgIds(String(row[imgCol] ?? ''))
        if (ids.length) {
          const saved = input.sourceUrl ? findMasterByUrl(input.sourceUrl) : null
          if (saved) pendingImages.push({ id: saved.id, imgIds: ids })
        }
      }
    } catch (err) {
      errors.push({ row: i + 1, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // 图片解析放后台：解 xlsx 里的 media → 缩图 → 回填。前端轮询任务进度。
  let imageTaskId: string | null = null
  if (isXlsxName && pendingImages.length) {
    const task = createTask('master-cell-images')
    imageTaskId = task.id
    runTask(
      task,
      async () => {
        const cellImages = await extractWpsCellImages(buf)
        let patched = 0
        for (let i = 0; i < pendingImages.length; i++) {
          const p = pendingImages[i]
          const urls = p.imgIds
            .map((id) => cellImages.get(id))
            .filter((u): u is string => Boolean(u))
          if (urls.length) {
            db.prepare('UPDATE master_products SET images=?, updated_at=? WHERE id=?').run(
              JSON.stringify(urls.slice(0, 8)),
              new Date().toISOString(),
              p.id
            )
            patched += 1
          }
          updateTask(task.id, { progress: `${i + 1}/${pendingImages.length}` })
        }
        return { patched, total: pendingImages.length }
      },
      0
    )
  }

  res.json({
    ok: true,
    created,
    updated,
    skipped,
    /** 导入同时自动建进产品流水线：新建 X 条、复用已有 Y 条 */
    productsCreated,
    productsLinked,
    errors: errors.slice(0, 20),
    total: Math.max(0, grid.length - headerRow - 1),
    /** 有这么多行带「嵌入单元格图片」，图片在后台解析 */
    pendingImages: pendingImages.length,
    imageTaskId,
  })
})
