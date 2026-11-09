import { randomUUID } from 'crypto'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { callChatJson } from './ai'
import {
  deleteImageBuffer,
  fetchImageBuffer,
  imageSize,
  readImageBuffer,
  saveImageBuffer,
  smallDataUrl,
} from './image-store'
import type { SourceInfo } from '../types'

/**
 * 视觉风格中心（服务层）
 *
 * 三块持久化数据：
 *   visual_refs            参考图库（图片真身进 image_blobs，永久保存）
 *   visual_styles          结构化风格配置（AI 学习产出，可人工改，版本递增）
 *   product_visual_profiles 每个产品识别到的品类 + 命中的风格（自动匹配状态落库）
 *
 * 硬规矩：风格参考图永远不是产品图。风格只描述「怎么拍」，不描述「拍什么」；
 * 产品的事实只来自产品原图（products.images）。
 */

export const VISUAL_CATEGORIES = ['main', 'showcase', 'detail', 'dimension', 'scene'] as const
export type VisualCategory = (typeof VISUAL_CATEGORIES)[number]

export const VISUAL_CATEGORY_LABEL: Record<VisualCategory, string> = {
  main: '主图',
  showcase: '产品展示图',
  detail: '细节图',
  dimension: '尺寸信息图',
  scene: '场景图',
}

export const FEEDBACK_REASONS = [
  { key: 'product_detail', label: '产品细节错误' },
  { key: 'product_color', label: '产品颜色错误' },
  { key: 'composition', label: '构图不协调' },
  { key: 'background', label: '背景不合适' },
  { key: 'texture', label: '质感不足' },
  { key: 'scene', label: '场景不真实' },
  { key: 'layout', label: '排版不精致' },
] as const

const API_PREFIX = process.env.API_PREFIX || '/api'
const refUrl = (id: string) => `${API_PREFIX}/visual-styles/refs/${id}/image`

/* ------------------------------------------------------------------ */
/* 参考图库                                                            */
/* ------------------------------------------------------------------ */

export interface VisualRef {
  id: string
  category: VisualCategory
  title: string
  note: string
  tags: string[]
  verdict: 'good' | 'ok' | 'bad'
  status: 'active' | 'inactive'
  favorite: boolean
  origin: string
  sourceUrl: string
  productId: string | null
  imageId: string | null
  url: string
  width: number | null
  height: number | null
  analyzedAt: string | null
  createdAt: string
  updatedAt: string
}

interface VisualRefRow {
  id: string
  category: string
  title: string
  note: string
  tags: string
  verdict: string
  status: string
  favorite: number
  origin: string
  source_url: string
  product_id: string | null
  image_id: string | null
  blob_key: string
  mime: string
  width: number | null
  height: number | null
  analyzed_at: string | null
  created_at: string
  updated_at: string
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function rowToRef(r: VisualRefRow): VisualRef {
  return {
    id: r.id,
    category: (VISUAL_CATEGORIES as readonly string[]).includes(r.category) ? (r.category as VisualCategory) : 'showcase',
    title: r.title,
    note: r.note,
    tags: parseJson<string[]>(r.tags, []),
    verdict: r.verdict === 'good' || r.verdict === 'bad' ? r.verdict : 'ok',
    status: r.status === 'inactive' ? 'inactive' : 'active',
    favorite: r.favorite === 1,
    origin: r.origin,
    sourceUrl: r.source_url,
    productId: r.product_id,
    imageId: r.image_id,
    url: refUrl(r.id),
    width: r.width,
    height: r.height,
    analyzedAt: r.analyzed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function getVisualRef(id: string): VisualRef {
  const row = db.prepare('SELECT * FROM visual_refs WHERE id = ?').get(id) as unknown as VisualRefRow | undefined
  if (!row) throw new AppError(404, '参考图不存在')
  return rowToRef(row)
}

export function listVisualRefs(filter: {
  category?: string
  status?: string
  verdict?: string
  favorite?: boolean
  limit?: number
} = {}): VisualRef[] {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.category) {
    where.push('category = ?')
    args.push(filter.category)
  }
  if (filter.status) {
    where.push('status = ?')
    args.push(filter.status)
  }
  if (filter.verdict) {
    where.push('verdict = ?')
    args.push(filter.verdict)
  }
  if (filter.favorite) where.push('favorite = 1')
  const limit = Math.max(1, Math.min(filter.limit ?? 200, 500))
  const rows = db
    .prepare(
      `SELECT * FROM visual_refs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY favorite DESC, created_at DESC LIMIT ${limit}`
    )
    .all(...args) as unknown as VisualRefRow[]
  return rows.map(rowToRef)
}

export function visualRefBuffer(id: string): Buffer {
  const row = db.prepare('SELECT blob_key FROM visual_refs WHERE id = ?').get(id) as unknown as
    | { blob_key: string }
    | undefined
  if (!row) throw new AppError(404, '参考图不存在')
  return readImageBuffer('_visual', fileFromBlobKey(row.blob_key))
}

/** blob_key 形如 `_visual/<file>`，读文件时只取文件名 */
function fileFromBlobKey(blobKey: string): string {
  const idx = blobKey.lastIndexOf('/')
  return idx >= 0 ? blobKey.slice(idx + 1) : blobKey
}

export async function addVisualRef(input: {
  dataUrl?: string
  url?: string
  buffer?: Buffer
  mime?: string
  category?: string
  title?: string
  note?: string
  tags?: string[]
  verdict?: string
  favorite?: boolean
  origin?: string
  sourceUrl?: string
  productId?: string | null
  imageId?: string | null
}): Promise<VisualRef> {
  const src = input.buffer ?? (await fetchImageBuffer(input.dataUrl || input.url || ''))
  if (!src.length) throw new AppError(400, '图片为空')
  if (src.length > 8 * 1024 * 1024) throw new AppError(400, '图片不能超过 8MB')
  const mime = input.mime || mimeFromDataUrl(input.dataUrl) || 'image/png'
  const id = randomUUID()
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
  const file = saveImageBuffer('_visual', src, ext)
  const size = await imageSize(src)
  const now = new Date().toISOString()
  const category = (VISUAL_CATEGORIES as readonly string[]).includes(input.category || '')
    ? (input.category as string)
    : 'showcase'
  db.prepare(
    `INSERT INTO visual_refs
      (id, category, title, note, tags, verdict, status, favorite, origin, source_url,
       product_id, image_id, blob_key, mime, width, height, analyzed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    id,
    category,
    input.title ?? '',
    input.note ?? '',
    JSON.stringify(input.tags ?? []),
    input.verdict === 'good' || input.verdict === 'bad' ? input.verdict : 'ok',
    input.favorite ? 1 : 0,
    input.origin ?? 'upload',
    input.sourceUrl ?? '',
    input.productId ?? null,
    input.imageId ?? null,
    `_visual/${file}`,
    mime,
    size.width,
    size.height,
    now,
    now
  )
  return getVisualRef(id)
}

function mimeFromDataUrl(s?: string): string | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(s ?? '')
  return m ? m[1] : null
}

export function updateVisualRef(
  id: string,
  patch: Partial<{
    category: string
    title: string
    note: string
    tags: string[]
    verdict: string
    status: string
    favorite: boolean
  }>
): VisualRef {
  getVisualRef(id)
  const sets: string[] = []
  const args: unknown[] = []
  const put = (col: string, val: unknown) => {
    sets.push(`${col} = ?`)
    args.push(val)
  }
  if (patch.category && (VISUAL_CATEGORIES as readonly string[]).includes(patch.category)) put('category', patch.category)
  if (patch.title !== undefined) put('title', String(patch.title).slice(0, 200))
  if (patch.note !== undefined) put('note', String(patch.note).slice(0, 1000))
  if (patch.tags !== undefined) put('tags', JSON.stringify((patch.tags ?? []).map(String).slice(0, 20)))
  if (patch.verdict && ['good', 'ok', 'bad'].includes(patch.verdict)) put('verdict', patch.verdict)
  if (patch.status && ['active', 'inactive'].includes(patch.status)) put('status', patch.status)
  if (patch.favorite !== undefined) put('favorite', patch.favorite ? 1 : 0)
  if (!sets.length) return getVisualRef(id)
  put('updated_at', new Date().toISOString())
  db.prepare(`UPDATE visual_refs SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  return getVisualRef(id)
}

export function deleteVisualRef(id: string): void {
  const row = db.prepare('SELECT * FROM visual_refs WHERE id = ?').get(id) as unknown as VisualRefRow | undefined
  if (!row) return
  const file = fileFromBlobKey(row.blob_key)
  if (file) deleteImageBuffer('_visual', file)
  db.prepare('DELETE FROM visual_refs WHERE id = ?').run(id)
}

/** 从历史生成图收藏：复制一份真身进视觉库，不依赖原来的产品图记录 */
export async function collectGeneratedImage(input: {
  productId: string
  imageId: string
  category?: string
  note?: string
  title?: string
  verdict?: string
}): Promise<VisualRef> {
  const existing = listVisualRefs({ limit: 500 }).find(
    (r) => r.productId === input.productId && r.imageId === input.imageId
  )
  if (existing) return existing
  const row = db
    .prepare('SELECT file, kind FROM product_images WHERE id = ? AND product_id = ?')
    .get(input.imageId, input.productId) as unknown as { file: string; kind: string } | undefined
  if (!row) throw new AppError(404, '生成图不存在')
  const buf = readImageBuffer(input.productId, row.file)
  const kindToCategory: Record<string, VisualCategory> = {
    main: 'main',
    dimension: 'dimension',
    detail: 'detail',
    scene: 'scene',
    intro: 'showcase',
  }
  return addVisualRef({
    buffer: buf,
    mime: 'image/png',
    category: input.category || kindToCategory[row.kind] || 'showcase',
    title: input.title || '',
    note: input.note || '',
    verdict: input.verdict || 'good',
    favorite: true,
    origin: 'generated',
    productId: input.productId,
    imageId: input.imageId,
  })
}

/* ------------------------------------------------------------------ */
/* 风格配置                                                            */
/* ------------------------------------------------------------------ */

export interface VisualStyleProfile {
  summary: string
  categoryFit: string[]
  composition: string
  productCoverage: string
  placement: string
  background: string
  palette: string
  lighting: string
  shadow: string
  texture: string
  angle: string
  depthOfField: string
  whitespace: string
  layout: string
  scene: string
  typography: string
  doList: string[]
  avoidList: string[]
  promptBlock: string
}

export const EMPTY_PROFILE: VisualStyleProfile = {
  summary: '',
  categoryFit: [],
  composition: '',
  productCoverage: '',
  placement: '',
  background: '',
  palette: '',
  lighting: '',
  shadow: '',
  texture: '',
  angle: '',
  depthOfField: '',
  whitespace: '',
  layout: '',
  scene: '',
  typography: '',
  doList: [],
  avoidList: [],
  promptBlock: '',
}

export interface VisualStyle {
  id: string
  name: string
  scope: 'global' | 'category'
  category: string
  status: 'active' | 'inactive'
  isDefault: boolean
  version: number
  profile: VisualStyleProfile
  promptBlock: string
  refIds: string[]
  refCount: number
  note: string
  model: string
  createdAt: string
  updatedAt: string
}

interface VisualStyleRow {
  id: string
  name: string
  scope: string
  category: string
  status: string
  is_default: number
  version: number
  profile: string
  prompt_block: string
  ref_ids: string
  note: string
  model: string
  created_at: string
  updated_at: string
}

function normalizeProfile(raw: unknown): VisualStyleProfile {
  const p = (raw ?? {}) as Partial<VisualStyleProfile>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 20) : []
  return {
    summary: str(p.summary),
    categoryFit: arr(p.categoryFit),
    composition: str(p.composition),
    productCoverage: str(p.productCoverage),
    placement: str(p.placement),
    background: str(p.background),
    palette: str(p.palette),
    lighting: str(p.lighting),
    shadow: str(p.shadow),
    texture: str(p.texture),
    angle: str(p.angle),
    depthOfField: str(p.depthOfField),
    whitespace: str(p.whitespace),
    layout: str(p.layout),
    scene: str(p.scene),
    typography: str(p.typography),
    doList: arr(p.doList),
    avoidList: arr(p.avoidList),
    promptBlock: str(p.promptBlock),
  }
}

function rowToStyle(r: VisualStyleRow): VisualStyle {
  const refIds = parseJson<string[]>(r.ref_ids, [])
  return {
    id: r.id,
    name: r.name,
    scope: r.scope === 'category' ? 'category' : 'global',
    category: r.category,
    status: r.status === 'inactive' ? 'inactive' : 'active',
    isDefault: r.is_default === 1,
    version: r.version,
    profile: normalizeProfile(parseJson<VisualStyleProfile>(r.profile, EMPTY_PROFILE)),
    promptBlock: r.prompt_block,
    refIds,
    refCount: refIds.length,
    note: r.note,
    model: r.model,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listVisualStyles(filter: { status?: string } = {}): VisualStyle[] {
  const rows = db
    .prepare(
      `SELECT * FROM visual_styles ${filter.status ? 'WHERE status = ?' : ''}
       ORDER BY is_default DESC, updated_at DESC`
    )
    .all(...(filter.status ? [filter.status] : [])) as unknown as VisualStyleRow[]
  return rows.map(rowToStyle)
}

export function getVisualStyle(id: string): VisualStyle {
  const row = db.prepare('SELECT * FROM visual_styles WHERE id = ?').get(id) as unknown as VisualStyleRow | undefined
  if (!row) throw new AppError(404, '风格配置不存在')
  return rowToStyle(row)
}

export function createVisualStyle(input: {
  name: string
  scope?: 'global' | 'category'
  category?: string
  note?: string
  profile?: Partial<VisualStyleProfile>
  promptBlock?: string
  refIds?: string[]
  isDefault?: boolean
}): VisualStyle {
  const name = input.name.trim()
  if (!name) throw new AppError(400, '风格名称不能为空')
  const id = randomUUID()
  const now = new Date().toISOString()
  const profile = normalizeProfile({ ...EMPTY_PROFILE, ...(input.profile ?? {}) })
  const defaultMode = input.isDefault ? 1 : 0
  if (defaultMode) db.prepare('UPDATE visual_styles SET is_default = 0').run()
  db.prepare(
    `INSERT INTO visual_styles
      (id, name, scope, category, status, is_default, version, profile, prompt_block, ref_ids, note, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, 1, ?, ?, ?, ?, '', ?, ?)`
  ).run(
    id,
    name,
    input.scope ?? 'global',
    input.category ?? '',
    defaultMode,
    JSON.stringify(profile),
    input.promptBlock ?? profile.promptBlock,
    JSON.stringify(input.refIds ?? []),
    input.note ?? '',
    now,
    now
  )
  return getVisualStyle(id)
}

export function updateVisualStyle(
  id: string,
  patch: Partial<{
    name: string
    scope: 'global' | 'category'
    category: string
    status: 'active' | 'inactive'
    isDefault: boolean
    note: string
    profile: Partial<VisualStyleProfile>
    promptBlock: string
    refIds: string[]
  }>
): VisualStyle {
  const cur = getVisualStyle(id)
  const sets: string[] = []
  const args: unknown[] = []
  const put = (col: string, val: unknown) => {
    sets.push(`${col} = ?`)
    args.push(val)
  }
  if (patch.name !== undefined) put('name', String(patch.name).trim().slice(0, 120) || cur.name)
  if (patch.scope) put('scope', patch.scope === 'category' ? 'category' : 'global')
  if (patch.category !== undefined) put('category', String(patch.category).slice(0, 200))
  if (patch.status) put('status', patch.status === 'inactive' ? 'inactive' : 'active')
  if (patch.isDefault !== undefined) {
    if (patch.isDefault) db.prepare('UPDATE visual_styles SET is_default = 0').run()
    put('is_default', patch.isDefault ? 1 : 0)
  }
  if (patch.note !== undefined) put('note', String(patch.note).slice(0, 2000))
  if (patch.profile) {
    const merged = normalizeProfile({ ...cur.profile, ...patch.profile })
    put('profile', JSON.stringify(merged))
    if (patch.promptBlock === undefined) put('prompt_block', merged.promptBlock || cur.promptBlock)
  }
  if (patch.promptBlock !== undefined) put('prompt_block', String(patch.promptBlock).slice(0, 8000))
  if (patch.refIds !== undefined) put('ref_ids', JSON.stringify((patch.refIds ?? []).slice(0, 40)))
  if (!sets.length) return cur
  put('updated_at', new Date().toISOString())
  db.prepare(`UPDATE visual_styles SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  return getVisualStyle(id)
}

export function deleteVisualStyle(id: string): void {
  db.prepare('DELETE FROM visual_styles WHERE id = ?').run(id)
}

/** 出图时注入的英文风格指令（没有 promptBlock 就等于没有风格，不硬编） */
export function styleBlockOf(style: VisualStyle | null): string {
  if (!style) return ''
  return (style.promptBlock || style.profile.promptBlock || '').trim()
}

/* ------------------------------------------------------------------ */
/* AI 学习视觉风格                                                     */
/* ------------------------------------------------------------------ */

/**
 * 让视觉模型看一组参考图，提炼「可复用规则」而不是抄某一张图的构图。
 * 失败必须显式报错（并提示换支持看图的模型），不能假装学习成功。
 */
export async function learnVisualStyle(input: {
  settings: Parameters<typeof callChatJson>[0]
  name: string
  category?: string
  scope?: 'global' | 'category'
  refIds?: string[]
  styleId?: string
  note?: string
  productHint?: string
}): Promise<VisualStyle> {
  const allRefs = input.refIds?.length
    ? input.refIds.map((id) => getVisualRef(id)).filter((r) => r.status === 'active')
    : listVisualRefs({ status: 'active', limit: 40 }).filter((r) => r.verdict !== 'bad')
  const refs = allRefs.slice(0, 6)
  if (!refs.length) throw new AppError(400, '没有可学习的参考图：先上传/收藏几张优秀作品')
  const images: string[] = []
  for (const r of refs) {
    try {
      images.push(await smallDataUrl(visualRefBuffer(r.id)))
    } catch {
      /* 单张读不到就跳过 */
    }
  }
  if (!images.length) throw new AppError(400, '参考图文件读取失败，请重新上传')

  const system = `You are the art director of a US promotional-products (ASI) supplier catalog.
You are given reference photos of GOOD product images (different products). Extract a REUSABLE visual style system — never a specific composition to copy.

Look at: composition, product coverage in frame, placement, background type, colour palette, lighting, shadow softness, material rendering, camera angle, depth of field, whitespace, layout rhythm, scene design, typography/icon style.

Rules:
- Describe RULES, not a single picture. The style must work for tumblers, speakers, power banks, storage and gift bags alike.
- Keep product fidelity absolute: the style may change background/light/crop, never the product.
- Write every descriptive field in CHINESE (the client reads it), concise (<= 80 chars each).
- promptBlock MUST be ENGLISH, 120-220 words, written as instructions to an image model: lighting, background, composition, camera, colour grading, spacing, DO NOTs. It must never mention any specific product, colourway, logo or brand.
- Output STRICT JSON only, no markdown.

JSON shape:
{"summary":"...","categoryFit":["..."],"composition":"...","productCoverage":"...","placement":"...","background":"...","palette":"...","lighting":"...","shadow":"...","texture":"...","angle":"...","depthOfField":"...","whitespace":"...","layout":"...","scene":"...","typography":"...","doList":["..."],"avoidList":["..."],"promptBlock":"..."}`

  const user = `Client style name: ${input.name}
Target categories (optional): ${input.category || '(all categories)'}
${input.productHint ? `Notes from the client: ${input.productHint}` : ''}
Reference images: ${refs.length} (some may be excellent works, some may be ordinary samples).

Extract the shared visual language and output the JSON.`

  let raw: Record<string, unknown>
  try {
    raw = await callChatJson<Record<string, unknown>>(input.settings, system, user, 0.4, images, {
      task: 'visual-style-learn',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new AppError(
      502,
      `风格学习失败：${msg}。如果提示模型不支持图片，请到「设置」把文本 AI 换成支持看图的模型（如 gpt-4o-mini / qwen-vl-plus）。`
    )
  }

  const profile = normalizeProfile(raw)
  if (!profile.promptBlock) profile.promptBlock = ''
  const promptBlock = String(profile.promptBlock || raw.promptBlock || '').trim()
  if (!promptBlock) throw new AppError(502, 'AI 没有返回可用的英文风格指令，请重试或手动填写')

  const now = new Date().toISOString()
  for (const r of refs) db.prepare('UPDATE visual_refs SET analyzed_at = ? WHERE id = ?').run(now, r.id)

  const refIds = refs.map((r) => r.id)
  if (input.styleId) {
    const cur = getVisualStyle(input.styleId)
    db.prepare(
      `UPDATE visual_styles SET name = ?, scope = ?, category = ?, version = ?, profile = ?, prompt_block = ?,
        ref_ids = ?, note = ?, model = ?, status = 'active', updated_at = ? WHERE id = ?`
    ).run(
      input.name.trim() || cur.name,
      input.scope ?? cur.scope,
      input.category ?? cur.category,
      cur.version + 1,
      JSON.stringify(profile),
      promptBlock,
      JSON.stringify(refIds),
      input.note ?? cur.note,
      '',
      now,
      cur.id
    )
    return getVisualStyle(cur.id)
  }
  const style = createVisualStyle({
    name: input.name,
    scope: input.scope ?? (input.category ? 'category' : 'global'),
    category: input.category ?? '',
    note: input.note ?? '',
    profile,
    promptBlock,
    refIds,
  })
  return getVisualStyle(style.id)
}

/* ------------------------------------------------------------------ */
/* 自动识别产品 + 匹配风格                                              */
/* ------------------------------------------------------------------ */

export interface ProductIdentification {
  /** 品类（中文，便于和资料库对上） */
  category: string
  /** 英文品类关键词（用于匹配风格和场景描述） */
  categoryEn: string
  colors: string[]
  structure: string
  material: string
  accessories: string[]
  usageScenes: string[]
  confidence: 'high' | 'medium' | 'low'
  source: 'ai' | 'fallback'
  note: string
}

export interface StyleMatch {
  identification: ProductIdentification
  style: VisualStyle | null
  reason: string
  refs: VisualRef[]
  cached: boolean
}

export interface ProductVisualProfileRow {
  id: string
  product_id: string
  data: string
  style_id: string | null
  style_reason: string
  ref_ids: string
  model: string
  created_at: string
  updated_at: string
}

/** 读缓存的产品识别/匹配结果（不调 AI、不花钱） */
export function getCachedMatch(productId: string): StyleMatch | null {
  try {
    const row = db.prepare('SELECT * FROM product_visual_profiles WHERE product_id = ?').get(productId) as unknown as
      | ProductVisualProfileRow
      | undefined
    if (!row) return null
    const identification = parseJson<ProductIdentification | null>(row.data, null)
    if (!identification) return null
    let style: VisualStyle | null = null
    if (row.style_id) {
      try {
        style = getVisualStyle(row.style_id)
      } catch {
        style = null
      }
    }
    const refIds = parseJson<string[]>(row.ref_ids, [])
    const refs = refIds
      .map((id) => {
        try {
          return getVisualRef(id)
        } catch {
          return null
        }
      })
      .filter((r): r is VisualRef => Boolean(r))
    return { identification, style, reason: row.style_reason, refs, cached: true }
  } catch {
    return null
  }
}

function saveMatch(productId: string, match: StyleMatch, model: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO product_visual_profiles
      (product_id, data, style_id, style_reason, ref_ids, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id) DO UPDATE SET data=excluded.data, style_id=excluded.style_id,
       style_reason=excluded.style_reason, ref_ids=excluded.ref_ids, model=excluded.model, updated_at=excluded.updated_at`
  ).run(
    productId,
    JSON.stringify(match.identification),
    match.style?.id ?? null,
    match.reason,
    JSON.stringify(match.refs.map((r) => r.id)),
    model,
    now,
    now
  )
}

/**
 * 用视觉模型识别产品（品类/颜色/结构/材质/配件/使用场景）。
 * 识别结果只用于「匹配风格 + 选场景」，绝不写进出图提示词的“产品事实”里去编造细节。
 */
export async function identifyProduct(
  settings: Parameters<typeof callChatJson>[0],
  source: SourceInfo
): Promise<ProductIdentification> {
  const images = (source.images ?? [])
    .filter((u) => /^(https?:\/\/|data:image\/)/i.test(u))
    .slice(0, 3)
  const fallback: ProductIdentification = {
    category: source.category || '',
    categoryEn: '',
    colors: (source.colorsCn || '')
      .split(/[/,，、;；|]/)
      .map((s) => s.trim())
      .filter(Boolean),
    structure: '',
    material: source.materialCn || '',
    accessories: [],
    usageScenes: [],
    confidence: 'low',
    source: 'fallback',
    note: images.length ? 'AI 识图不可用，按资料库字段匹配风格' : '没有产品图，按资料库字段匹配风格',
  }
  if (!images.length) return fallback

  const system = `You identify physical products from supplier photos for a US promotional-products catalog.
Report ONLY what is clearly visible. Do not guess hidden parts, materials or functions.
Output STRICT JSON only:
{"category":"中文品类","categoryEn":"english category keywords","colors":["..."],"structure":"一句话结构","material":"真实材质","accessories":["..."],"usageScenes":["..."],"confidence":"high|medium|low","note":"不确定的地方"}`

  const user = `Supplier title: ${source.sourceTitle || '(none)'}
Supplier material field: ${source.materialCn || '(none)'}
Supplier colours field: ${source.colorsCn || '(none)'}
Supplier size field: ${source.sizeCn || '(none)'}
Supplier description: ${(source.description || '').slice(0, 500) || '(none)'}

Look at the photos and identify the product. Keep every field grounded in what is visible.`

  try {
    const raw = await callChatJson<Record<string, unknown>>(settings, system, user, 0.2, images, {
      task: 'image-identify',
    })
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 12) : [])
    return {
      category: String(raw.category ?? source.category ?? '').slice(0, 60),
      categoryEn: String(raw.categoryEn ?? '').slice(0, 120),
      colors: arr(raw.colors).length ? arr(raw.colors) : fallback.colors,
      structure: String(raw.structure ?? '').slice(0, 300),
      material: String(raw.material ?? source.materialCn ?? '').slice(0, 120),
      accessories: arr(raw.accessories),
      usageScenes: arr(raw.usageScenes),
      confidence: raw.confidence === 'high' || raw.confidence === 'medium' ? raw.confidence : 'low',
      source: 'ai',
      note: String(raw.note ?? '').slice(0, 300),
    }
  } catch {
    return fallback
  }
}

/** 本地品类匹配：风格 category 字段用 / , 、 分隔关键词，命中即得分 */
export function matchStyleLocal(
  source: { sourceTitle?: string; category?: string; materialCn?: string },
  identification: ProductIdentification,
  styles: VisualStyle[]
): { style: VisualStyle | null; reason: string } {
  const active = styles.filter((s) => s.status === 'active')
  if (!active.length) return { style: null, reason: '视觉风格库还没有生效的风格配置，先到「视觉风格中心」学习一条' }
  const hay = [
    source.sourceTitle,
    source.category,
    source.materialCn,
    identification.category,
    identification.categoryEn,
    identification.material,
    identification.usageScenes.join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  let best: { style: VisualStyle; score: number; hits: string[] } | null = null
  for (const s of active) {
    const keywords = [s.category, ...s.profile.categoryFit]
      .join(',')
      .split(/[,，、/;；|]/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length >= 2)
    const hits = keywords.filter((k) => hay.includes(k))
    const score = hits.length * 10 + (s.isDefault ? 3 : 0) + (s.scope === 'global' ? 1 : 0)
    if (!best || score > best.score) best = { style: s, score, hits }
  }
  if (!best) return { style: null, reason: '没有可用的风格配置' }
  if (best.hits.length) {
    return { style: best.style, reason: `品类命中「${best.hits.slice(0, 3).join(' / ')}」→ 使用风格「${best.style.name}」` }
  }
  return {
    style: best.style,
    reason: best.style.isDefault
      ? `没有品类关键词命中，使用默认风格「${best.style.name}」`
      : `没有品类关键词命中，暂用「${best.style.name}」（可在风格里把本品类加进适用品类）`,
  }
}

/** 选风格参考图：风格自带的 > 收藏的优秀作品 > 同品类优秀作品 */
export function pickRefsForStyle(style: VisualStyle | null, identification: ProductIdentification, limit = 2): VisualRef[] {
  const active = listVisualRefs({ status: 'active', limit: 200 }).filter((r) => r.verdict !== 'bad')
  const byId = new Map(active.map((r) => [r.id, r]))
  const picked: VisualRef[] = []
  const push = (r: VisualRef | undefined) => {
    if (r && !picked.some((p) => p.id === r.id) && picked.length < limit) picked.push(r)
  }
  if (style) for (const id of style.refIds) push(byId.get(id))
  const hay = `${identification.category} ${identification.categoryEn} ${identification.usageScenes.join(' ')}`.toLowerCase()
  const sameCategory = active.filter((r) => r.category === 'main' || r.category === 'showcase')
  for (const r of sameCategory) {
    if (picked.length >= limit) break
    const text = `${r.title} ${r.note} ${r.tags.join(' ')}`.toLowerCase()
    if (hay && text && hay.split(/\s+/).some((w) => w.length >= 2 && text.includes(w))) push(r)
  }
  for (const r of active.filter((x) => x.favorite)) push(r)
  for (const r of active) push(r)
  return picked.slice(0, limit)
}

/**
 * 自动识别 + 匹配风格。缓存命中直接返回（不重复花 AI 钱）。
 * force=true 时重新识图（用户在界面上点「重新识别」）。
 */
export async function autoMatchProduct(input: {
  settings: Parameters<typeof callChatJson>[0]
  productId: string
  source: SourceInfo
  force?: boolean
}): Promise<StyleMatch> {
  if (!input.force) {
    const cached = getCachedMatch(input.productId)
    if (cached) return cached
  }
  const identification = await identifyProduct(input.settings, input.source)
  const styles = listVisualStyles({ status: 'active' })
  const { style, reason } = matchStyleLocal(input.source, identification, styles)
  const refs = pickRefsForStyle(style, identification, 2)
  const match: StyleMatch = {
    identification,
    style,
    reason,
    refs,
    cached: false,
  }
  saveMatch(input.productId, match, '')
  return match
}

/* ------------------------------------------------------------------ */
/* 产品确认尺寸                                                        */
/* ------------------------------------------------------------------ */

export interface ProductDimensions {
  lengthIn: number | null
  widthIn: number | null
  heightIn: number | null
  thicknessIn: number | null
  extra: Array<{ label: string; value: number }>
  updatedAt: string | null
}

interface DimensionRow {
  product_id: string
  length_in: number | null
  width_in: number | null
  height_in: number | null
  thickness_in: number | null
  extra: string
  updated_at: string
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function getDimensions(productId: string): ProductDimensions {
  const row = db.prepare('SELECT * FROM product_dimensions WHERE product_id = ?').get(productId) as unknown as
    | DimensionRow
    | undefined
  if (!row) return { lengthIn: null, widthIn: null, heightIn: null, thicknessIn: null, extra: [], updatedAt: null }
  return {
    lengthIn: row.length_in,
    widthIn: row.width_in,
    heightIn: row.height_in,
    thicknessIn: row.thickness_in,
    extra: parseJson<Array<{ label: string; value: number }>>(row.extra, []),
    updatedAt: row.updated_at,
  }
}

export function saveDimensions(
  productId: string,
  patch: Partial<{
    lengthIn: number | null
    widthIn: number | null
    heightIn: number | null
    thicknessIn: number | null
    extra: Array<{ label: string; value: number }>
  }>
): ProductDimensions {
  const cur = getDimensions(productId)
  const next: ProductDimensions = {
    lengthIn: patch.lengthIn !== undefined ? num(patch.lengthIn) : cur.lengthIn,
    widthIn: patch.widthIn !== undefined ? num(patch.widthIn) : cur.widthIn,
    heightIn: patch.heightIn !== undefined ? num(patch.heightIn) : cur.heightIn,
    thicknessIn: patch.thicknessIn !== undefined ? num(patch.thicknessIn) : cur.thicknessIn,
    extra:
      patch.extra !== undefined
        ? (patch.extra ?? [])
            .map((e) => ({ label: String(e.label ?? '').slice(0, 24), value: Number(e.value) }))
            .filter((e) => e.label && Number.isFinite(e.value) && e.value > 0)
            .slice(0, 6)
        : cur.extra,
    updatedAt: new Date().toISOString(),
  }
  db.prepare(
    `INSERT INTO product_dimensions (product_id, length_in, width_in, height_in, thickness_in, extra, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id) DO UPDATE SET length_in=excluded.length_in, width_in=excluded.width_in,
       height_in=excluded.height_in, thickness_in=excluded.thickness_in, extra=excluded.extra, updated_at=excluded.updated_at`
  ).run(
    productId,
    next.lengthIn,
    next.widthIn,
    next.heightIn,
    next.thicknessIn,
    JSON.stringify(next.extra),
    next.updatedAt
  )
  return next
}

/**
 * 确认尺寸 → 尺寸图标注参数。
 * 底部标「长」、右侧标「高」、左上斜线标「宽」；厚度等其余尺寸用底部图例文字（程序绘制，保证准确）。
 */
export function dimensionSpecOf(d: ProductDimensions): {
  widthIn: number
  heightIn: number
  depthIn: number | null
  legend: string
} | null {
  const bottom = d.lengthIn ?? d.widthIn
  const height = d.heightIn
  if (!bottom || !height) return null
  const depth = d.lengthIn && d.widthIn && d.widthIn !== d.lengthIn ? d.widthIn : null
  const parts: string[] = []
  if (d.lengthIn) parts.push(`L ${fmt1(d.lengthIn)}"`)
  if (d.widthIn) parts.push(`W ${fmt1(d.widthIn)}"`)
  if (d.heightIn) parts.push(`H ${fmt1(d.heightIn)}"`)
  if (d.thicknessIn) parts.push(`T ${fmt1(d.thicknessIn)}"`)
  for (const e of d.extra) parts.push(`${e.label} ${fmt1(e.value)}"`)
  return { widthIn: bottom, heightIn: height, depthIn: depth, legend: parts.join('   ') }
}

const fmt1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1)

/* ------------------------------------------------------------------ */
/* 反馈                                                                */
/* ------------------------------------------------------------------ */

export function recordImageFeedback(input: {
  imageId: string
  productId: string
  verdict: 'like' | 'dislike'
  reasons?: string[]
  note?: string
  styleId?: string | null
  styleName?: string
  promptVersion?: string
  productCategory?: string
}): { id: string; verdict: string; reasons: string[] } {
  const id = randomUUID()
  const reasons = (input.reasons ?? []).map(String).filter(Boolean).slice(0, 10)
  db.prepare(
    `INSERT INTO image_feedback
      (id, image_id, product_id, verdict, reasons, note, style_id, style_name, prompt_version, product_category, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.imageId,
    input.productId,
    input.verdict,
    JSON.stringify(reasons),
    input.note ?? '',
    input.styleId ?? null,
    input.styleName ?? '',
    input.promptVersion ?? '',
    input.productCategory ?? '',
    new Date().toISOString()
  )
  return { id, verdict: input.verdict, reasons }
}

/** 反馈汇总：哪些原因最常出现（给风格配置改进提供依据） */
export function feedbackSummary(limit = 20): {
  total: number
  likes: number
  dislikes: number
  reasons: Array<{ key: string; count: number }>
} {
  const rows = db.prepare('SELECT verdict, reasons FROM image_feedback ORDER BY created_at DESC LIMIT 1000').all() as unknown as Array<{
    verdict: string
    reasons: string
  }>
  const counts = new Map<string, number>()
  let likes = 0
  for (const r of rows) {
    if (r.verdict === 'like') likes++
    for (const k of parseJson<string[]>(r.reasons, [])) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return {
    total: rows.length,
    likes,
    dislikes: rows.length - likes,
    reasons: [...counts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit),
  }
}
