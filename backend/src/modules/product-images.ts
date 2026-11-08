import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db, getSetting, setSetting } from '../db'
import { AppError } from '../middleware/errorHandler'
import { AiError, callChat, callChatJson } from '../services/ai'
import { editImage, generateImage, ImageRef, ImageSettings, testImageConnection } from '../services/image-gen'
import { buildImagePromptSet, buildIntroSuggestions, translateImageEditInstruction } from '../services/image-prompts'
import { overlayDimensions } from '../services/dimension-overlay'
import { finalizeMainImage } from '../services/image-post'
import Jimp from 'jimp'
import { ProductImage, ProductImageKind, SourceInfo } from '../types'
import { reviewProductImage } from '../services/image-review'
import { fetch1688Page } from './products'
import { loadSettings } from './settings'
import {
  contentTypeOf,
  dataUrlToBuffer,
  fetchRemoteImage,
  isHttpUrl,
  isManagedImage,
  normalizeImage,
  normalizeRemoteUrl,
  toJpegDataUrl,
} from '../services/image-source'
import { createTask, getTask, runTask, updateTask } from '../services/task-manager'
import { findProduct } from './products'

export const productImagesRouter: Router = Router()

// ---------- 存储目录 ----------
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'images')

function productDir(productId: string): string {
  const dir = path.join(IMAGES_DIR, productId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 图片存储：文件系统仅作缓存，真身持久化在 DB image_blobs 表。
 * Render 容器 /tmp 会被每次部署清空，纯文件存储会导致图片全丢（记录还在 DB，读文件报「图片文件不存在」）。
 * 写入 = 落盘缓存 + 存 DB；读取 = 缓存命中直接返回，未命中从 DB 恢复缓存后返回。
 */
function blobKey(productId: string, file: string): string {
  return `${productId}/${path.basename(file)}`
}

function saveImageFile(productId: string, buf: Buffer, ext = 'png'): string {
  const safeExt = /^(png|jpg|webp|gif|bmp)$/i.test(ext) ? ext.toLowerCase() : 'png'
  const file = `${Date.now()}-${randomUUID().slice(0, 8)}.${safeExt}`
  fs.writeFileSync(path.join(productDir(productId), file), buf)
  db.prepare('INSERT INTO image_blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(
    blobKey(productId, file),
    buf
  )
  return file
}

/** 我们自己存储里的图片地址（同源，不分防盗链，部署后从 DB 恢复） */
function managedImageUrl(productId: string, file: string): string {
  return `/api/product-images/${productId}/${path.basename(file)}`
}

/**
 * 内容寻址保存（文件名=图片内容哈希）：
 * 同一张图不管从哪个链接、抓几次都落到同一个文件，产品图列表自然去重，
 * 也不会因为重复抓取而堆一堆一样的图。
 */
function saveContentImage(productId: string, buf: Buffer, ext: string): string {
  const safeExt = /^(png|jpg|webp|gif|bmp)$/i.test(ext) ? ext.toLowerCase() : 'jpg'
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16)
  const file = `src-${hash}.${safeExt}`
  const fp = path.join(productDir(productId), file)
  if (!fs.existsSync(fp)) {
    try {
      fs.writeFileSync(fp, buf)
      db.prepare(
        'INSERT INTO image_blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data'
      ).run(blobKey(productId, file), buf)
    } catch {
      /* 写缓存失败不阻塞，真身本来就在外部链接/数据库 */
    }
  }
  return managedImageUrl(productId, file)
}

/** 把外链图片下载下来存进我们自己的存储，返回新地址；失败抛错（带原因） */
async function mirrorImage(productId: string, rawUrl: string): Promise<string> {
  const remote = await fetchRemoteImage(rawUrl, { timeoutMs: 6000 })
  const norm = await normalizeImage(remote.buffer, { max: 1600, quality: 88 })
  return saveContentImage(productId, norm.buffer, norm.ext)
}

interface MirrorFailure {
  url: string
  error: string
}

/** 批量转存（并发 4，单张 6 秒超时）；失败的保留原地址并回报原因 */
async function mirrorImages(
  productId: string,
  urls: string[],
  opts?: { deadline?: number }
): Promise<{ mapped: Map<string, string>; failed: MirrorFailure[] }> {
  const mapped = new Map<string, string>()
  const failed: MirrorFailure[] = []
  const queue = urls.filter((u) => isHttpUrl(u))
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const u = queue.shift()
      if (!u) return
      // 总时长兜底：Render 代理 100 秒就断，宁可留几张「稍后重试」也不要整页 502
      if (opts?.deadline && Date.now() > opts.deadline) {
        failed.push({ url: u, error: '下载超时，稍后点「一键修复/转存」重试' })
        continue
      }
      try {
        mapped.set(u, await mirrorImage(productId, u))
      } catch (err) {
        failed.push({ url: u, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })
  await Promise.all(workers)
  return { mapped, failed }
}

/** 把产品图地址换成本地存储地址（能转存的转存，转不了的保留原链接） */
function mergeSourceImages(productId: string, current: string[], incoming: string[], mapped: Map<string, string>) {
  const conv = (u: string) => mapped.get(u) ?? u
  const merged = Array.from(new Set([...current.map(conv), ...incoming.map(conv)]))
  db.prepare('UPDATE products SET images=?, updated_at=? WHERE id=?').run(
    JSON.stringify(merged),
    new Date().toISOString(),
    productId
  )
  return merged
}

/** 图片地址转存后，把「每种图选中的参考图」里对应的老地址一起换掉，否则选好的参考图会失效 */
function remapPlanSources(productId: string, mapped: Map<string, string>): void {
  if (!mapped.size) return
  let plans: Record<string, KindPlan>
  try {
    plans = readPlan(productId)
  } catch {
    return
  }
  for (const k of KINDS) {
    const cur = plans[k]?.sources ?? []
    const next = cur.map((u) => mapped.get(u) ?? u)
    if (next.some((u, i) => u !== cur[i])) savePlan(productId, k, { sources: next })
    // 参考图（只学风格）也要跟着换地址，否则选好的风格参考会失效
    const curRefs = plans[k]?.refs ?? []
    const nextRefs = curRefs.map((u) => mapped.get(u) ?? u)
    if (nextRefs.some((u, i) => u !== curRefs[i])) savePlan(productId, k, { refs: nextRefs })
  }
}

function readImageFile(productId: string, file: string): Buffer {
  // 防路径穿越：只允许文件名
  const safe = path.basename(file)
  const fp = path.join(productDir(productId), safe)
  if (fs.existsSync(fp)) return fs.readFileSync(fp)
  // 缓存缺失（部署清空 /tmp）：从 DB 恢复
  const row = db.prepare('SELECT data FROM image_blobs WHERE key = ?').get(blobKey(productId, safe)) as
    | { data: Buffer | Uint8Array | string }
    | undefined
  if (!row) throw new AppError(404, '图片文件不存在')
  const buf = Buffer.from(row.data as Uint8Array)
  try {
    fs.writeFileSync(fp, buf)
  } catch {
    /* 缓存写失败不阻塞（下次再从 DB 读） */
  }
  return buf
}

// ---------- DB 行映射 ----------
interface ImageRow {
  id: string
  product_id: string
  kind: string
  slot: number
  prompt: string
  history: string
  file: string
  dimension_spec: string | null
  with_logo: number | null
  review: string | null
  created_at: string
  updated_at: string
}

function rowToImage(r: ImageRow): ProductImage {
  return {
    id: r.id,
    productId: r.product_id,
    kind: r.kind as ProductImageKind,
    slot: r.slot,
    prompt: r.prompt,
    withLogo: r.with_logo == null ? undefined : r.with_logo === 1,
    history: JSON.parse(r.history || '[]'),
    file: r.file,
    dimensionSpec: r.dimension_spec ? JSON.parse(r.dimension_spec) : null,
    review: r.review ? (JSON.parse(r.review) as ProductImage['review']) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function listImages(productId: string): ProductImage[] {
  const rows = db
    .prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY created_at ASC')
    .all(productId) as unknown as ImageRow[]
  return rows.map(rowToImage)
}

function findImage(productId: string, imageId: string): ProductImage {
  const row = db
    .prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?')
    .get(imageId, productId) as unknown as ImageRow | undefined
  if (!row) throw new AppError(404, '图片记录不存在')
  return rowToImage(row)
}

// ---------- Logo ----------
const LOGO_KEY = 'brand-logo'

function getLogoFile(): string | null {
  const v = getSetting(LOGO_KEY)
  return v ? path.basename(v) : null
}

/** 读取 Logo Buffer（无 Logo 返回 null；缓存缺失时从 DB image_blobs 恢复） */
function readLogo(): Buffer | null {
  const file = getLogoFile()
  if (!file) return null
  const fp = path.join(IMAGES_DIR, '_brand', file)
  if (fs.existsSync(fp)) return fs.readFileSync(fp)
  const row = db.prepare('SELECT data FROM image_blobs WHERE key = ?').get(`_brand/${file}`) as
    | { data: Buffer | Uint8Array | string }
    | undefined
  if (!row) return null
  const buf = Buffer.from(row.data as Uint8Array)
  try {
    fs.mkdirSync(path.join(IMAGES_DIR, '_brand'), { recursive: true })
    fs.writeFileSync(fp, buf)
  } catch {
    /* 缓存写失败不阻塞 */
  }
  return buf
}

/** 上传/更新品牌 Logo（multipart 字段名 logo，PNG 透明底最佳） */
productImagesRouter.post('/logo', async (req: Request, res: Response) => {
  const parts = req.body ?? {}
  // 简化实现：接受 JSON base64（前端 FileReader 读为 dataURL），避免引入 multer
  const schema = z.object({ dataUrl: z.string().min(64).max(8_000_000) })
  const { dataUrl } = schema.parse(parts)
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl)
  if (!m) throw new AppError(400, 'Logo 必须是 png/jpeg/webp 的 base64 dataURL')
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > 5 * 1024 * 1024) throw new AppError(400, 'Logo 不能超过 5MB')

  const dir = path.join(IMAGES_DIR, '_brand')
  fs.mkdirSync(dir, { recursive: true })
  const file = `logo-${Date.now()}.png`
  fs.writeFileSync(path.join(dir, file), buf)
  // Logo 真身也存 DB：部署清空 /tmp 后可恢复
  db.prepare('INSERT INTO image_blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(
    `_brand/${file}`,
    buf
  )
  setSetting(LOGO_KEY, file)
  res.json({ ok: true, logoUrl: `/api/product-images/logo` })
})

/** 获取品牌 Logo */
productImagesRouter.get('/logo', async (_req: Request, res: Response) => {
  const buf = readLogo()
  if (!buf) throw new AppError(404, '尚未上传 Logo')
  res.setHeader('Content-Type', 'image/png')
  res.setHeader('Cache-Control', 'no-store')
  res.send(buf)
})

/** 图像服务连通性测试 */
productImagesRouter.post('/test', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<ImageSettings>
  const current = loadSettings()
  const probe: ImageSettings = {
    imageBaseUrl: body.imageBaseUrl ?? current.imageBaseUrl,
    imageApiKey: body.imageApiKey && !body.imageApiKey.includes('****') ? body.imageApiKey : current.imageApiKey,
    imageModel: body.imageModel ?? current.imageModel,
    imageSize: '1024x1024',
    imageQuality: 'low',
  }
  res.json(await testImageConnection(probe))
})

// ---------- 生成 5 张图 ----------
const generateSchema = z.object({
  source: z
    .object({
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
    .optional(),
  productId: z.string().optional(),
  /** 尺寸图标注（inch）；不传则从 listing.productSizeInch/source.sizeCn 解析 */
  dimensions: z
    .object({
      widthIn: z.coerce.number().positive(),
      heightIn: z.coerce.number().positive(),
      depthIn: z.coerce.number().positive().nullable().optional(),
    })
    .optional(),
  /** 只生成指定角色（默认全部 5 张） */
  /** 要生成哪几种图：主图/尺寸图/细节图/场景图（intro 是旧名字，等同 detail） */
  kinds: z.array(z.enum(['main', 'dimension', 'intro', 'detail', 'scene'])).max(6).optional(),
  /** 主图样式：white=纯白底单主图；combo=产品+卖点组合展示（仍纯白底，不出现文字） */
  mainStyle: z.enum(['white', 'combo']).optional(),
  /** 生成前用户注意事项（中文，可空）：融入 Prompt 编排，AI 必须遵循 */
  notes: z.string().max(2000).optional(),
  /** 主图是否融合品牌 Logo（默认 true；false=干净产品图，禁止出现任何 Logo） */
  withLogo: z.boolean().optional(),
})

/** 把任意图片地址读成 data URL（模型一定读得到；外链防盗链/过期都不影响出图） */
async function refToDataUrl(u: string): Promise<string> {
  if (u.startsWith('data:image/')) {
    const parsed = dataUrlToBuffer(u)
    if (!parsed) throw new Error('图片数据损坏')
    return toJpegDataUrl(parsed.buffer, 1200, 84)
  }
  if (isManagedImage(u)) {
    const m = /^\/api\/product-images\/([^/]+)\/([^/?#]+)/.exec(u)
    if (!m) throw new Error('图片地址无法识别')
    return toJpegDataUrl(readImageFile(decodeURIComponent(m[1]), decodeURIComponent(m[2])), 1200, 84)
  }
  const remote = await fetchRemoteImage(u, { timeoutMs: 9000 })
  return toJpegDataUrl(remote.buffer, 1200, 84)
}

/** 生成前的产品资料 */
function buildProductInfoBlock(source: SourceInfo, listingSizeInch?: string): string {
  const lines = [
    source.sourceTitle ? `- Product: ${source.sourceTitle}` : '',
    source.category ? `- Category: ${source.category}` : '',
    source.materialCn ? `- Material: ${source.materialCn}` : '',
    source.colorsCn ? `- Colours: ${source.colorsCn}` : '',
    source.sizeCn ? `- Size: ${source.sizeCn}` : listingSizeInch ? `- Size: ${listingSizeInch}` : '',
    source.moq ? `- MOQ: ${source.moq}` : '',
    source.description ? `- Details: ${source.description.slice(0, 600)}` : '',
    source.notes ? `- Notes: ${source.notes.slice(0, 300)}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

/** 审查时把图缩到 512px 再发（视觉 token 大头在分辨率，512 足够判断一致性） */
async function smallDataUrl(buf: Buffer): Promise<string> {
  try {
    const img = await Jimp.read(buf)
    img.scaleToFit(512, 512)
    const out = await img.quality(80).getBufferAsync(Jimp.MIME_JPEG)
    return `data:image/jpeg;base64,${out.toString('base64')}`
  } catch {
    return `data:image/png;base64,${buf.toString('base64')}`
  }
}

async function runAi<T>(fn: () => Promise<T>): Promise<T> {  try {
    return await fn()
  } catch (err) {
    if (err instanceof AiError) {
      throw new AppError(502, err.hint ? `${err.message}｜${err.hint}` : err.message)
    }
    throw err
  }
}

/** 解析尺寸图标注用的 inch 尺寸：优先 listing 英制尺寸，其次 sizeCn（1688 尺寸默认按 cm 换算） */
function parseDimensions(source: SourceInfo, listingSizeInch?: string) {
  // 1) listing.productSizeInch（AI 生成 + 人工核对，如 39.37" W x 15.75" H / 11.81" Diameter）
  const inchText = (listingSizeInch ?? '').trim()
  if (inchText) {
    const nums = [...inchText.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
    if (nums.length >= 2) {
      return { widthIn: nums[0], heightIn: nums[1], depthIn: nums.length >= 3 ? nums[2] : null }
    }
  }
  // 2) sizeCn：1688 尺寸默认 cm（即使没写单位，如 "100x40"）；只有明确标注英寸才不换算
  const cn = (source.sizeCn ?? '').trim()
  if (!cn) return null
  const nums = [...cn.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
  if (nums.length < 2) return null
  const isIn = /in|inch|["”]|英寸/i.test(cn)
  const isMm = /mm|毫米/i.test(cn)
  const conv = (n: number) => (isIn ? n : isMm ? n / 25.4 : n / 2.54)
  return {
    widthIn: conv(nums[0]),
    heightIn: conv(nums[1]),
    depthIn: nums.length >= 3 ? conv(nums[2]) : null,
  }
}

// ---------- 每种图的出图计划（参考哪些产品图 + 生成前对话） ----------
export interface KindPlan {
  /** 这张图参考的产品图（产品真身：1688 抓的 / 人工上传的） */
  sources: string[]
  /**
   * 这张图额外参考的「风格参考图」（只学构图/排版/光线/场景，绝不许改产品）。
   * 空数组 = 沿用该产品全部参考图（默认行为）；选了就只送选中的，最多 2 张。
   */
  refs: string[]
  notes: string
  chat: Array<{ role: 'user' | 'assistant'; content: string; at: string }>
}

const KINDS = ['main', 'dimension', 'detail', 'scene'] as const

function kindLabelOf(kind: string): string {
  return kind === 'main'
    ? '主图'
    : kind === 'dimension'
      ? '尺寸图'
      : kind === 'detail'
        ? '细节图'
        : kind === 'scene'
          ? '场景图'
          : kind
}

function readPlan(productId: string): Record<string, KindPlan> {
  const out: Record<string, KindPlan> = {}
  for (const k of KINDS) out[k] = { sources: [], refs: [], notes: '', chat: [] }
  try {
    const rows = db
      .prepare('SELECT kind, sources, refs, notes, chat FROM product_image_plan WHERE product_id = ?')
      .all(productId) as unknown as Array<{
      kind: string
      sources: string
      refs: string | null
      notes: string
      chat: string
    }>
    for (const r of rows) {
      out[r.kind] = {
        sources: JSON.parse(r.sources || '[]') as string[],
        refs: JSON.parse(r.refs || '[]') as string[],
        notes: r.notes || '',
        chat: JSON.parse(r.chat || '[]') as Array<{ role: 'user' | 'assistant'; content: string; at: string }>,
      }
    }
  } catch {
    /* 表还没建好时返回空计划 */
  }
  return out
}

function savePlan(productId: string, kind: string, patch: Partial<KindPlan>): Record<string, KindPlan> {
  const cur = readPlan(productId)[kind] ?? { sources: [], refs: [], notes: '', chat: [] }
  const next: KindPlan = {
    sources: patch.sources ?? cur.sources,
    refs: patch.refs ?? cur.refs,
    notes: patch.notes ?? cur.notes,
    chat: patch.chat ?? cur.chat,
  }
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO product_image_plan (product_id, kind, sources, refs, notes, chat, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id, kind) DO UPDATE SET sources=excluded.sources, refs=excluded.refs, notes=excluded.notes, chat=excluded.chat, updated_at=excluded.updated_at`
  ).run(
    productId,
    kind,
    JSON.stringify(next.sources),
    JSON.stringify(next.refs ?? []),
    next.notes,
    JSON.stringify(next.chat),
    now
  )
  return readPlan(productId)
}

/** 读取四种图的出图计划 */
productImagesRouter.get('/product/:productId/plan', (req: Request, res: Response) => {
  const plan = readPlan(String(req.params.productId))
  res.json({ plan })
})

/** 保存某种图的参考图 / 注意点 / 对话记录 */
productImagesRouter.put('/product/:productId/plan', (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  const body = z
    .object({
      kind: z.enum(KINDS),
      sources: z.array(z.string().max(8_000_000)).max(100).optional(),
      /** 这张图额外参考的「风格参考图」（只学风格，最多 2 张会真正送模型） */
      refs: z.array(z.string().max(8_000_000)).max(100).optional(),
      notes: z.string().max(3000).optional(),
      chat: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000), at: z.string().optional() }))
        .max(40)
        .optional(),
    })
    .parse(req.body ?? {})
  const plan = savePlan(productId, body.kind, {
    sources: body.sources,
    refs: body.refs,
    notes: body.notes,
    chat: body.chat?.map((c) => ({ role: c.role, content: c.content, at: c.at ?? new Date().toISOString() })),
  })
  res.json({ plan })
})

/**
 * 自动挑图：让视觉模型先认清每张产品图是「正面 / 侧面 / 特写 / 场景 / 其他颜色」，
 * 再按用途给主图/尺寸图/细节图/场景图各挑参考图。
 * 用户手上十几张图往往分不清哪张适合哪种图，这一步省掉逐张点选。
 */
productImagesRouter.post('/product/:productId/plan/auto', async (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  const p = findProduct(productId)
  const settings = loadSettings()
  const urls = (p.source.images ?? [])
    .filter((u) => isHttpUrl(u) || isManagedImage(u) || u.startsWith('data:image/'))
    .slice(0, 6)
  if (!urls.length) throw new AppError(400, '还没有产品图：先「从 1688 抓取」或上传/粘贴产品图')

  // 转成模型能读的 data URL（外链防盗链/失效都不影响）
  const images: string[] = []
  for (const u of urls) {
    try {
      images.push(await refToDataUrl(u))
    } catch {
      /* 单张失败跳过 */
    }
  }
  if (!images.length)
    throw new AppError(400, '产品图都读不出来（链接可能已失效）：先点「一键修复/转存」或重新上传图片')

  const system = `You are a product-photo editor for a US promotional-products (ASI) catalogue.
You receive several photos of the SAME product, numbered 1..N in the order they are sent.

Classify every photo into exactly one role:
- FRONT: clean front or three-quarter view showing the whole product clearly, little clutter
- SIDE: straight side / top / back / orthographic view, useful for showing dimensions
- DETAIL: close-up of material, stitching, texture, structure, mechanism or accessory
- SCENE: product in real use / lifestyle / model / environment (not a clean studio shot)
- COLOR: photo included mainly to show another colourway
- OTHER: anything else

Then choose the best reference photos for four catalogue images:
- MAIN: 1-3 photos, prefer FRONT; must show shape and colour clearly
- DIMENSION: 1-2 photos, prefer SIDE or a distortion-free FRONT
- DETAIL: 1-2 photos, prefer DETAIL close-ups
- SCENE: 1-2 photos, prefer SCENE; if there is none, use the best FRONT

Output STRICT JSON only:
{"roles":[{"index":1,"role":"FRONT","reason":"short"}],"picks":{"MAIN":[1,2],"DIMENSION":[1],"DETAIL":[3],"SCENE":[4]}}

Rules:
- Only use indices that exist.
- Prefer variety; do not pick the same photo for every slot unless it is the only one.
- Never invent photos, features or roles that are not visible.`

  let raw: {
    roles?: Array<{ index?: number; role?: string; reason?: string }>
    picks?: Record<string, unknown>
  }
  try {
    raw = await callChatJson<typeof raw>(
      settings,
      system,
      `Photos of one product, numbered 1..${images.length} in the order sent. Classify them and pick the references.`,
      0.2,
      images
    )
  } catch (err) {
    throw new AppError(502, `自动挑图失败：${err instanceof Error ? err.message : String(err)}`)
  }

  const max = urls.length
  const pick = (key: string, limit: number): string[] => {
    const list = Array.isArray(raw.picks?.[key]) ? (raw.picks?.[key] as unknown[]) : []
    return Array.from(
      new Set(
        list
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= max)
          .map((n) => urls[n - 1])
      )
    ).slice(0, limit)
  }
  const fromRole = (roles: string[], limit: number): string[] =>
    Array.from(
      new Set(
        (raw.roles ?? [])
          .filter(
            (r) =>
              typeof r?.index === 'number' &&
              r.index >= 1 &&
              r.index <= max &&
              roles.includes(String(r.role ?? '').toUpperCase())
          )
          .map((r) => urls[Number(r.index) - 1])
      )
    ).slice(0, limit)

  const picks = {
    main: pick('MAIN', 3).length ? pick('MAIN', 3) : fromRole(['FRONT'], 2).length ? fromRole(['FRONT'], 2) : urls.slice(0, 2),
    dimension: pick('DIMENSION', 2).length ? pick('DIMENSION', 2) : fromRole(['SIDE', 'FRONT'], 2),
    detail: pick('DETAIL', 2).length ? pick('DETAIL', 2) : fromRole(['DETAIL'], 2),
    scene: pick('SCENE', 2).length ? pick('SCENE', 2) : fromRole(['SCENE'], 2),
  }

  for (const k of KINDS) {
    if (picks[k].length) savePlan(productId, k, { sources: picks[k] })
  }
  res.json({ picks, roles: raw.roles ?? [], count: urls.length, plan: readPlan(productId) })
})

/**
 * 生成前先对话：让 AI 先读懂产品 + 用户对这张图的要求，给出构图确认和一份「生成注意点」。
 * 只调文本模型，不消耗出图费用；用户确认后再点生成。
 */
productImagesRouter.post('/product/:productId/plan/chat', async (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  const body = z
    .object({
      kind: z.enum(KINDS),
      message: z.string().min(1).max(2000),
      messages: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
        .max(30)
        .optional(),
    })
    .parse(req.body ?? {})
  const product = findProduct(productId)
  const settings = loadSettings()
  const plan = readPlan(productId)[body.kind]
  const kindLabel =
    body.kind === 'main'
      ? '主图（纯白底、产品突出、其他颜色小图放下方或右侧）'
      : body.kind === 'dimension'
        ? '尺寸图（纯白底、真实外观 + 英寸标注）'
        : body.kind === 'detail'
          ? '细节图（真实材质/结构/功能特写）'
          : '场景图（真实使用场景）'

  const colors = String(product.listing?.colors || product.source.colorsCn || '') || '(未提供)'
  const material = String(product.listing?.material || product.source.materialCn || '') || '(未提供)'

  const system = `你是 ASI 促销礼品行业的图片美术指导。用户在生成产品图之前，先和你确认这张图要怎么拍。

规则（必须遵守）：
- 产品必须和用户提供的产品照片完全一致：形状、结构、配件、材质、纹理、比例、颜色都不得改变，不得凭空增加或减少任何部件。
- 颜色只能用用户明确提供的颜色，照片里没有的颜色一律不许出现。
- 主图/尺寸图必须纯白底；不要出现任何文字、数字、尺寸线、水印。
- 你只能给「怎么拍」的建议（构图、角度、光线、留白、展示哪些卖点），不能改动产品本身。

用中文回答，200 字以内，分点说清：①这张图重点展示什么 ②构图/角度怎么安排 ③要避免什么。
最后单独给一行：NOTES: <一段可直接交给生图模型的中文注意点>`

  const history = (body.messages ?? []).slice(-10)
  const user = `产品：${product.source.sourceTitle || product.code}
产品编号：${product.code}
这张图是：${kindLabel}
材质：${material}
可用颜色：${colors}
用户为这张图选了几张产品参考图：${plan.sources.length || '未单独选，将用产品图'}

对话记录：
${history.map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.content}`).join('\n') || '(无)'}

用户这次说：${body.message}`

  let reply = ''
  let notes = ''
  try {
    const text = await callChat(settings, system, user, 0.4)
    const m = text.match(/NOTES:\s*([\s\S]+)$/i)
    reply = (m ? text.replace(m[0], '') : text).trim()
    notes = (m ? m[1] : '').trim()
  } catch (err) {
    throw new AppError(502, `对话失败：${err instanceof Error ? err.message : String(err)}`)
  }

  const now = new Date().toISOString()
  const chat = [...plan.chat, { role: 'user' as const, content: body.message, at: now }]
  if (reply) chat.push({ role: 'assistant' as const, content: reply, at: now })
  const mergedNotes = notes ? (plan.notes ? `${plan.notes}\n${notes}` : notes) : plan.notes
  savePlan(productId, body.kind, { chat, notes: mergedNotes })
  res.json({ reply, notes, plan: readPlan(productId) })
})

// ---------- 产品图 / 参考图（两个独立区域） ----------
/**
 * 「产品图」= 产品自己的真身图（1688 抓的 / 人工上传），是生成时的事实基准；
 * 「参考图」= 人工上传或粘贴的行业优秀图，只学构图/排版/光线/场景，
 * 绝不允许改变产品本身（结构/外形/颜色/材质/配件/比例/功能/纹理）。
 */

interface RefRow {
  id: string
  product_id: string
  url: string
  file: string
  note: string
  created_at: string
}

function listRefs(productId: string): Array<{ id: string; url: string; createdAt: string; note: string }> {
  let rows: RefRow[] = []
  try {
    rows = db
      .prepare('SELECT * FROM product_ref_images WHERE product_id = ? ORDER BY created_at ASC')
      .all(productId) as unknown as RefRow[]
  } catch {
    rows = []
  }
  return rows.map((r) => ({ id: r.id, url: r.url, createdAt: r.created_at, note: r.note }))
}

/** 产品自己的图（products.images），前端「产品图」区展示 */
productImagesRouter.get('/product/:productId/sources', (req: Request, res: Response) => {
  const p = findProduct(String(req.params.productId))
  const images = (p.source.images ?? []).filter((u) => typeof u === 'string' && u.length > 0)
  res.json({
    images,
    count: images.length,
    sourceUrl: p.source.sourceUrl ?? '',
    /** 已经抓到过 1688 图没有（没有就可以点「从 1688 抓取」） */
    hasSourceImages: images.some((u) => /^https?:\/\//.test(u) || isManagedImage(u) || u.startsWith('data:image')),
  })
})

/** 从 1688 链接补抓产品详情图 / 颜色图，抓到的合并进产品图，并告诉前端这次新增了哪几张 */
productImagesRouter.post('/product/:productId/fetch-source', async (req: Request, res: Response) => {
  const id = String(req.params.productId)
  const p = findProduct(id)
  if (!p.source.sourceUrl) throw new AppError(400, '这个产品没有 1688 链接，无法抓图；可以手动上传或在下面粘贴图片地址')
  let fetched: string[] = []
  let message = ''
  try {
    const r = await fetch1688Page(p.source.sourceUrl)
    fetched = (r.fetched?.images ?? []).filter((u) => typeof u === 'string' && u.length > 0)
    message = r.message || ''
  } catch (err) {
    throw new AppError(502, `抓取失败：${err instanceof Error ? err.message : String(err)}。可以手动粘贴图片地址`)
  }
  const before = new Set(p.source.images ?? [])
  const added = fetched.filter((u) => !before.has(u))
  // 抓到的 1688 外链立刻下载转存：以后链接失效/防盗链都不会再变成破损图，出图也一定读得到
  const { mapped, failed } = await mirrorImages(id, added.slice(0, 20), { deadline: Date.now() + 35_000 })
  const merged = mergeSourceImages(id, p.source.images ?? [], fetched, mapped)
  remapPlanSources(id, mapped)
  res.json({
    ok: true,
    added: added.length,
    total: merged.length,
    /** 这次新增的图（前端高亮展示「抓到哪几张」，已经是本地地址） */
    addedImages: added.map((u) => mapped.get(u) ?? u),
    images: merged,
    mirrored: mapped.size,
    failed,
    message,
  })
})

/** 产品图：手动追加图片地址（1688 抓不到时的兜底）。加进来时立刻下载转存，避免以后链接失效变破损图 */
productImagesRouter.post('/product/:productId/sources', async (req: Request, res: Response) => {
  const id = String(req.params.productId)
  const body = z
    .object({ urls: z.array(z.string().max(8_000_000)).min(1).max(20) })
    .parse(req.body ?? {})
  const p = findProduct(id)
  const raws = body.urls.map((u) => u.trim()).filter(Boolean)
  const valid = raws.filter((u) => isHttpUrl(u) || u.startsWith('data:image/'))

  // 粘贴/截图来的 base64：压缩后直接存进我们的存储
  const localFromData: string[] = []
  for (const u of valid.filter((x) => x.startsWith('data:image/'))) {
    const parsed = dataUrlToBuffer(u)
    if (!parsed) continue
    const norm = await normalizeImage(parsed.buffer, { max: 1600, quality: 88 })
    localFromData.push(saveContentImage(id, norm.buffer, norm.ext))
  }

  const httpUrls = valid.filter((u) => isHttpUrl(u))
  const { mapped, failed } = await mirrorImages(id, httpUrls, { deadline: Date.now() + 55_000 })
  const incoming = [...localFromData, ...httpUrls.map((u) => mapped.get(u) ?? u)]
  const merged = mergeSourceImages(id, p.source.images ?? [], incoming, mapped)
  remapPlanSources(id, mapped)
  res.json({
    images: merged,
    added: merged.length - (p.source.images ?? []).length,
    /** 下载成功、已经变成我们自己的图片的张数 */
    mirrored: mapped.size,
    failed,
  })
})

/** 产品图：修复破损 / 把还没转存的外链图下载到我们自己的存储 */
productImagesRouter.post('/product/:productId/sources/mirror', async (req: Request, res: Response) => {
  const id = String(req.params.productId)
  const body = z.object({ urls: z.array(z.string().max(4000)).max(30).optional() }).parse(req.body ?? {})
  const p = findProduct(id)
  const current = p.source.images ?? []
  const targets = (body.urls?.length ? body.urls : current.filter(isHttpUrl)).filter(isHttpUrl).slice(0, 30)

  // base64 大图（截图/粘贴进来的）顺手压成站内文件：列表不再动辄几百 KB
  const dataUrls = body.urls?.length ? [] : current.filter((u) => u.startsWith('data:image/')).slice(0, 30)
  const inlineMapped = new Map<string, string>()
  for (const u of dataUrls) {
    const parsed = dataUrlToBuffer(u)
    if (!parsed) continue
    try {
      const norm = await normalizeImage(parsed.buffer, { max: 1600, quality: 88 })
      inlineMapped.set(u, saveContentImage(id, norm.buffer, norm.ext))
    } catch {
      /* 单张失败不影响其他 */
    }
  }

  if (!targets.length && !inlineMapped.size) {
    res.json({ images: current, mirrored: 0, failed: [] as MirrorFailure[] })
    return
  }
  const { mapped, failed } = await mirrorImages(id, targets, { deadline: Date.now() + 60_000 })
  const allMapped = new Map([...mapped, ...inlineMapped])
  const merged = mergeSourceImages(id, current, [], allMapped)
  remapPlanSources(id, allMapped)
  res.json({ images: merged, mirrored: allMapped.size, failed })
})

/** 产品图：外链是否还能打开（前端给破损图标做体检） */
productImagesRouter.post('/product/:productId/sources/check', async (req: Request, res: Response) => {
  const id = String(req.params.productId)
  const body = z.object({ urls: z.array(z.string().max(4000)).max(40).optional() }).parse(req.body ?? {})
  const p = findProduct(id)
  const targets = (body.urls?.length ? body.urls : (p.source.images ?? []).filter(isHttpUrl)).slice(0, 40)
  const results = await Promise.all(
    targets.map(async (u) => {
      try {
        const r = await fetchRemoteImage(u, { timeoutMs: 7000 })
        return { url: u, ok: true, contentType: r.contentType, bytes: r.buffer.length, error: '' }
      } catch (err) {
        return {
          url: u,
          ok: false,
          contentType: '',
          bytes: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    })
  )
  res.json({ results })
})

/** 公开图片：给 ASI 目录导入 / 外部系统抓图用（不需要登录；文件名是内容哈希，猜不到） */
productImagesRouter.get('/public/:productId/:file', async (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  const file = String(req.params.file)
  const buf = readImageFile(productId, file)
  res.setHeader('Content-Type', contentTypeOf(path.extname(file).slice(1)))
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.send(buf)
})

/** 外链图片代理：浏览器直接引用 1688 图会被防盗链拦成破损图，这里由服务器带 Referer 取回再转发 */
productImagesRouter.get('/proxy', async (req: Request, res: Response) => {
  const raw = String(req.query.url ?? '')
  if (!isHttpUrl(normalizeRemoteUrl(raw))) throw new AppError(400, '缺少图片地址（url 参数，http(s):// 开头）')
  const remote = await fetchRemoteImage(raw, { timeoutMs: 12_000 })
  res.setHeader('Content-Type', remote.contentType)
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable')
  res.send(remote.buffer)
})


/** 产品图：删掉其中一张（按地址精确匹配） */
productImagesRouter.post('/product/:productId/sources/remove', (req: Request, res: Response) => {
  const id = String(req.params.productId)
  const body = z.object({ url: z.string().min(1).max(8_000_000) }).parse(req.body ?? {})
  const p = findProduct(id)
  const before = p.source.images ?? []
  const after = before.filter((u) => u !== body.url)
  if (after.length === before.length) {
    res.json({ images: before, removed: 0 })
    return
  }
  db.prepare('UPDATE products SET images=?, updated_at=? WHERE id=?').run(
    JSON.stringify(after),
    new Date().toISOString(),
    id
  )
  res.json({ images: after, removed: before.length - after.length })
})

/** 参考图列表 */
productImagesRouter.get('/product/:productId/refs', (req: Request, res: Response) => {
  res.json({ refs: listRefs(String(req.params.productId)) })
})

/** 新增参考图（粘贴 URL / base64）：一律先存进我们自己的存储，避免以后链接失效 */
productImagesRouter.post('/product/:productId/refs', async (req: Request, res: Response) => {
  const id = String(req.params.productId)
  const body = z
    .object({
      urls: z.array(z.string().max(4000)).max(10).optional(),
      images: z.array(z.string().max(8_000_000)).max(10).optional(),
      note: z.string().max(300).optional(),
    })
    .parse(req.body ?? {})
  const urls = [...(body.urls ?? []), ...(body.images ?? [])]
    .map((u) => u.trim())
    .filter((u) => isHttpUrl(u) || u.startsWith('data:image/') || isManagedImage(u))
  if (!urls.length) throw new AppError(400, '没有可用的图片地址（要 http(s):// 或 data:image 开头）')
  const existing = listRefs(id)
  const room = Math.max(0, 6 - existing.length)
  if (!room) throw new AppError(400, '参考图最多 6 张，先删几张再加')
  const now = new Date().toISOString()
  const stmt = db.prepare(
    'INSERT INTO product_ref_images (id, product_id, url, file, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const failed: MirrorFailure[] = []
  const seen = new Set(existing.map((r) => r.url))
  const deadline = Date.now() + 55_000
  let added = 0
  for (const u of urls.slice(0, room)) {
    let stored = u
    if (u.startsWith('data:image/')) {
      const parsed = dataUrlToBuffer(u)
      if (!parsed) {
        failed.push({ url: u.slice(0, 80), error: '不是有效的 base64 图片' })
        continue
      }
      const norm = await normalizeImage(parsed.buffer, { max: 1600, quality: 88 })
      stored = saveContentImage(id, norm.buffer, norm.ext)
    } else if (isHttpUrl(u)) {
      if (Date.now() > deadline) {
        failed.push({ url: u, error: '下载超时，先保留原链接' })
      } else {
        try {
          stored = await mirrorImage(id, u)
        } catch (err) {
          failed.push({ url: u, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    if (seen.has(stored)) continue
    seen.add(stored)
    stmt.run(randomUUID(), id, stored, '', body.note ?? '', now)
    added += 1
  }
  res.json({ ok: true, refs: listRefs(id), added, failed })
})


/** 删除参考图 */
productImagesRouter.delete('/refs/:refId', (req: Request, res: Response) => {
  db.prepare('DELETE FROM product_ref_images WHERE id = ?').run(String(req.params.refId))
  res.json({ ok: true })
})

productImagesRouter.post('/generate', async (req: Request, res: Response) => {
  const body = generateSchema.parse(req.body ?? {})
  const settings = loadSettings()

  // 解析产品：优先 productId，其次请求体 source（同步解析，404/400 立即返回给前端）
  let source: SourceInfo
  let productId: string
  let listingSizeInch: string | undefined
  if (body.productId) {
    // 复用 products 模块的列式解析（products 表无 source JSON 列，直接 JSON.parse 会崩）
    const p = findProduct(body.productId)
    source = p.source
    productId = p.id
    // listing 英制尺寸（AI 生成+人工核对）优先用于尺寸图标注
    listingSizeInch = p.listing?.productSizeInch || undefined
  } else if (body.source) {
    source = body.source as unknown as SourceInfo
    productId = 'preview'
  } else {
    throw new AppError(400, '请提供 productId 或 source')
  }

  const dims = body.dimensions ?? parseDimensions(source, listingSizeInch)
  // 四种模式：主图 1 张、尺寸图 1 张、细节图+场景图合计 2~3 张。
  // 默认给一套完整组合（主图 + 尺寸图 + 2 张细节 + 1 张场景 = 3 张细节/场景，符合上限）。
  const rawKinds = body.kinds ?? ['main', 'dimension', 'detail', 'detail', 'scene']
  // 细节/场景合计超过 3 张就截断（硬上限）
  const detailSceneCap = 3
  let detailScene = 0
  const kinds: ProductImageKind[] = []
  for (const k of rawKinds) {
    const kind = (k === 'intro' ? 'detail' : k) as ProductImageKind
    if (kind === 'main' || kind === 'dimension') {
      if (!kinds.includes(kind)) kinds.push(kind)
      continue
    }
    if (detailScene >= detailSceneCap) continue
    detailScene += 1
    kinds.push(kind)
  }
  if (!kinds.length) kinds.push('main')
  const mainStyle = body.mainStyle ?? 'white'

  const logo = readLogo()
  // 主图 Logo 开关：默认加 Logo；用户明确选择不加时不传 Logo 参考图（还省 1 张输入费）
  const withLogo = body.withLogo !== false

  // 「产品图」才是产品事实基准：只认产品真身图（1688 抓的 / 人工上传的 / 已转存到本地的），含 data URL。
  // 「参考图」只学构图/光线/场景，单独传给生图模型，并在提示词里明确禁止改产品。
  const isImageRef = (u: string) => isHttpUrl(u) || isManagedImage(u) || u.startsWith('data:image/')
  const productUrls = (source.images ?? []).filter(isImageRef)
  const styleRefs = listRefs(productId)
    .map((r) => r.url)
    .filter(isImageRef)

  // 每种图各自的参考图来自「出图计划」：用户为这张图单独挑的产品图；
  // 没挑就用产品图兜底（主图多给几张，便于看清结构和颜色）。
  const plan = productId !== 'preview' ? readPlan(productId) : ({} as Record<string, KindPlan>)
  const urlsForKind = (kind: string): string[] => {
    const picked = (plan[kind]?.sources ?? []).filter((u) => productUrls.includes(u))
    return picked.length ? picked : productUrls.slice(0, kind === 'main' ? 4 : 2)
  }
  /**
   * 这张图用哪些「风格参考图」：
   *   · 该图种单独选过 → 只送选中的（最多 2 张），不同图种可以学不同风格；
   *   · 一张没选 → 沿用全部参考图（和以前一样，所有图种共用）。
   */
  const styleRefsForKind = (kind: string): string[] => {
    const picked = (plan[kind]?.refs ?? []).filter((u) => styleRefs.includes(u))
    return picked.length ? picked : styleRefs
  }

  // 生图前先读产品资料（特点/颜色/材质/场景），拼成事实清单交给提示词编排
  const productInfo = buildProductInfoBlock(source, listingSizeInch)
  // 每种图在生成前对话里确认过的注意点，带上图种标签一起交给提示词编排
  const kindNotes = kinds
    .map((k) => {
      const n = plan[k]?.notes?.trim()
      if (!n) return ''
      const label = k === 'main' ? '主图' : k === 'dimension' ? '尺寸图' : k === 'detail' ? '细节图' : '场景图'
      return `【${label}】${n}`
    })
    .filter(Boolean)
    .join('\n')
  const allNotes = [body.notes?.trim(), kindNotes].filter(Boolean).join('\n')

  // 异步任务：5 张图逐张生成耗时 1-5 分钟，同步等待会超 Render 100 秒代理超时（502）
  const task = createTask('generate-product-images')
  const created: ProductImage[] = []
  const now = () => new Date().toISOString()
  // Prompt 集缓存：任务重试时复用，只重新生成失败的图
  let promptSet: Awaited<ReturnType<typeof buildImagePromptSet>> | null = null

  runTask(task, async () => {
    // 0) 参考图先在服务器侧读成 data URL：外链防盗链 / 链接过期都不会让模型拿不到实物而瞎画
    const refCache = new Map<string, string>()
    const resolveUrls = async (urls: string[], limit = 6): Promise<string[]> => {
      const out: string[] = []
      for (const u of urls.slice(0, limit)) {
        try {
          let dataUrl = refCache.get(u)
          if (!dataUrl) {
            dataUrl = await refToDataUrl(u)
            refCache.set(u, dataUrl)
          }
          out.push(dataUrl)
        } catch {
          /* 单张失败先跳过，全部失败时下面会拦住 */
        }
      }
      return out
    }
    const kindRefs: Record<string, string[]> = {
      // 主图参考图同时用来写 Prompt（模型要先看见产品），所以总是读
      main: await resolveUrls(urlsForKind('main')),
      dimension: [],
      detail: [],
      scene: [],
    }
    for (const k of ['dimension', 'detail', 'scene'] as const) {
      kindRefs[k] = kinds.includes(k) ? await resolveUrls(urlsForKind(k)) : []
    }
    for (const k of ['main', 'dimension', 'detail', 'scene']) {
      if (kinds.includes(k as ProductImageKind) && !kindRefs[k].length) {
        throw new AppError(
          400,
          `「${kindLabelOf(k)}」的产品参考图一张都读不出来（链接可能已失效）：请到产品图区点「修复破损图」或重新抓取/上传产品图后再生成`
        )
      }
    }
    const styleDataUrls = await resolveUrls(styleRefs)

    // 1) 文本模型产出全部图片的 Prompt（带产品事实清单 + 真实参考图；用户注意点融入编排）
    const ps =
      promptSet ??
      (promptSet = await runAi(() =>
        buildImagePromptSet({ ...source, images: kindRefs.main.slice(0, 6) }, settings, allNotes, withLogo, {
          productInfo,
          styleRefCount: Math.min(styleDataUrls.length, 2),
          mainStyle,
          withDetail: kinds.includes('detail'),
          withScene: kinds.includes('scene'),
        })
      ))

    // 2) 逐张生成（任务重试时跳过已完成的，续跑剩余的）
    for (const kind of kinds) {
      const isMulti = kind === 'detail' || kind === 'scene' || kind === 'intro'
      const existing = created.filter((c) => c.kind === kind).length
      const slot = isMulti ? existing + 1 : 0
      if (created.some((c) => c.kind === kind && c.slot === slot)) continue
      const prompt =
        kind === 'main'
          ? ps.main
          : kind === 'dimension'
            ? ps.dimension
            : kind === 'scene'
              ? (ps.scene[slot - 1] ?? ps.scene[0] ?? ps.detail[0] ?? ps.main)
              : (ps.detail[slot - 1] ?? ps.detail[0] ?? ps.main)

      // 产品图放前面（事实），风格参考图放最后 2 张（模型通常把靠后的图当风格参考）
      const styleDataUrlsForKind = await resolveUrls(styleRefsForKind(kind), 2)
      const refsWithStyle: ImageRef[] = [
        ...kindRefs[kind].map((u) => ({ url: u }) as ImageRef),
        ...(kind === 'main' && logo && withLogo ? [{ buffer: logo } as ImageRef] : []),
        ...styleDataUrlsForKind.map((u) => ({ url: u }) as ImageRef),
      ]

      let buf = await runAi(() => generateImage(settings, prompt, refsWithStyle))

      // 主图：外圈刷成纯白。生图模型常给一点点灰底/渐变，而 ASI 目录要求纯白背景。
      // 只清理外圈（提示词保证那里是空白边距），不会动到产品本身的浅色边缘。
      if (kind === 'main') buf = await finalizeMainImage(buf)

      // 尺寸图：程序化叠加 inch 标注
      let dimensionSpec: ProductImage['dimensionSpec'] = null
      if (kind === 'dimension' && dims) {
        const spec = { widthIn: dims.widthIn, heightIn: dims.heightIn, depthIn: dims.depthIn ?? null }
        buf = await overlayDimensions(buf, spec)
        dimensionSpec = spec
      }

      // 同角色同槽位替换：先删旧记录与旧文件（含 DB blob），避免多次生成后重复堆积
      for (const old of listImages(productId).filter((i) => i.kind === kind && i.slot === slot)) {
        try {
          fs.unlinkSync(path.join(productDir(productId), old.file))
        } catch {
          /* 旧文件可能已不存在 */
        }
        db.prepare('DELETE FROM product_images WHERE id = ?').run(old.id)
        db.prepare('DELETE FROM image_blobs WHERE key = ?').run(`${productId}/${path.basename(old.file)}`)
      }
      const file = saveImageFile(productId, buf)
      const id = randomUUID()
      const record: ProductImage = {
        id,
        productId,
        kind,
        slot,
        prompt,
        history: [],
        file,
        dimensionSpec,
        withLogo,
        createdAt: now(),
        updatedAt: now(),
      }
      db.prepare(
        `INSERT INTO product_images (id, product_id, kind, slot, prompt, history, file, dimension_spec, with_logo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.id,
        record.productId,
        record.kind,
        record.slot,
        record.prompt,
        JSON.stringify(record.history),
        record.file,
        record.dimensionSpec ? JSON.stringify(record.dimensionSpec) : null,
        withLogo ? 1 : 0,
        record.createdAt,
        record.updatedAt
      )

      // 3) 自动审查：拿生成图对照原产品图，按 8 项硬指标体检（不通过就把问题记下来）
      try {
        const parsedListing = productId !== 'preview' ? findProduct(productId).listing : null
        const expectColors = String(parsedListing?.colors || source.colorsCn || '')
          .split(/[/,，、]/)
          .map((s) => s.trim())
          .filter(Boolean)
        const review = await reviewProductImage(
          settings,
          {
            image: await smallDataUrl(buf),
            productImages: kindRefs[kind].slice(0, 2),
            kind,
            colors: expectColors,
            material: String(parsedListing?.material || source.materialCn || ''),
            hasLogo: withLogo && kind === 'main',
          },
          productId === 'preview' ? null : productId
        )
        if (review) {
          record.review = review
          db.prepare('UPDATE product_images SET review=? WHERE id=?').run(JSON.stringify(review), record.id)
        }
      } catch {
        /* 审查失败不影响出图结果 */
      }

      created.push(record)
      updateTask(task.id, { progress: `已完成 ${created.length}/${kinds.length} 张` })
    }

    return { images: created, urls: created.map((c) => `/api/product-images/${productId}/${c.file}`) }
  })

  res.json({ taskId: task.id, status: task.status })
})

// ---------- 任务轮询：查询图片生成任务状态/结果 ----------
// 注意：必须注册在 GET /:productId/:file 之前，避免 "tasks" 被当作 productId
productImagesRouter.get('/tasks/:taskId', (req: Request, res: Response) => {
  const task = getTask(String(req.params.taskId))
  if (!task) {
    throw new AppError(404, '任务不存在或已过期（服务重启会清空任务，请重新生成）')
  }
  res.json(task)
})

// ---------- 对话式修改图片 ----------
const chatSchema = z.object({
  productId: z.string().min(1),
  imageId: z.string().min(1),
  message: z.string().min(1).max(2000),
})

productImagesRouter.post('/chat', async (req: Request, res: Response) => {
  const body = chatSchema.parse(req.body ?? {})
  const settings = loadSettings()
  const image = findImage(body.productId, body.imageId)

  // 1) 文本模型把中文意图翻译成英文编辑指令
  const { editPrompt, reply } = await runAi(() =>
    translateImageEditInstruction(body.message, image.prompt, image.kind, settings)
  )

  // 2) 用当前图（+ Logo，仅当该主图原本就带 Logo）作为参考图进行编辑
  const refs: ImageRef[] = [{ buffer: readImageFile(body.productId, image.file) }]
  const logo = readLogo()
  if (logo && image.kind === 'main' && image.withLogo !== false) refs.push({ buffer: logo })

  let buf = await runAi(() => editImage(settings, editPrompt, refs))

  // 尺寸图：重新叠加标注（保持数字精确）
  if (image.kind === 'dimension' && image.dimensionSpec) {
    buf = await overlayDimensions(buf, image.dimensionSpec)
  }

  // 3) 新版本覆盖保存（保留历史链）
  const file = saveImageFile(body.productId, buf)
  const history = [
    ...image.history,
    { role: 'user' as const, content: body.message, at: new Date().toISOString() },
    { role: 'assistant' as const, content: reply, at: new Date().toISOString() },
  ]
  db.prepare('UPDATE product_images SET file=?, prompt=?, history=?, updated_at=? WHERE id=?').run(
    file,
    editPrompt,
    JSON.stringify(history),
    new Date().toISOString(),
    image.id
  )

  res.json({
    image: { ...image, file, prompt: editPrompt, history, updatedAt: new Date().toISOString() },
    reply,
    url: `/api/product-images/${body.productId}/${file}`,
  })
})

// ---------- 介绍图文字建议（不生成图片，省 AI 费用） ----------
productImagesRouter.post('/intro-suggestions', async (req: Request, res: Response) => {
  const body = z.object({ productId: z.string().min(1) }).parse(req.body ?? {})
  const p = findProduct(body.productId)
  const suggestions = await runAi(() => buildIntroSuggestions(p.source, loadSettings()))
  res.json({ suggestions })
})

// ---------- 查询产品图片列表 ----------
productImagesRouter.get('/product/:productId', async (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  res.json({ images: listImages(productId) })
})

// ---------- 读取图片文件 ----------
productImagesRouter.get('/:productId/:file', async (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  const file = String(req.params.file)
  const buf = readImageFile(productId, file)
  res.setHeader('Content-Type', contentTypeOf(path.extname(file).slice(1)))
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.send(buf)
})

// ---------- 删除单张 ----------
productImagesRouter.delete('/:imageId', async (req: Request, res: Response) => {
  const imageId = String(req.params.imageId)
  const row = db.prepare('SELECT * FROM product_images WHERE id = ?').get(imageId) as
    | (ImageRow & { product_id: string })
    | undefined
  if (!row) throw new AppError(404, '图片记录不存在')
  db.prepare('DELETE FROM product_images WHERE id = ?').run(imageId)
  try {
    const fp = path.join(productDir(row.product_id), path.basename(row.file))
    if (fs.existsSync(fp)) fs.unlinkSync(fp)
  } catch {
    /* 文件清理失败不阻塞 */
  }
  db.prepare('DELETE FROM image_blobs WHERE key = ?').run(`${row.product_id}/${path.basename(row.file)}`)
  res.json({ ok: true })
})

// ---------- 删除产品全部图片 ----------
productImagesRouter.delete('/product/:productId/all', async (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  db.prepare('DELETE FROM product_images WHERE product_id = ?').run(productId)
  try {
    fs.rmSync(productDir(productId), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  db.prepare('DELETE FROM image_blobs WHERE key LIKE ?').run(`${productId}/%`)
  res.json({ ok: true })
})

// ---------- 重新生成单张（同 Prompt 换种子） ----------
productImagesRouter.post('/:imageId/regenerate', async (req: Request, res: Response) => {
  const imageId = String(req.params.imageId)
  const body = z.object({ productId: z.string().min(1) }).parse(req.body ?? {})
  const settings = loadSettings()
  const image = findImage(body.productId, imageId)

  const logo = readLogo()
  let buf: Buffer
  if (image.kind === 'main' && logo && image.withLogo !== false) {
    // 带 Logo 的主图：用旧图 + Logo 编辑重生成
    buf = await runAi(() =>
      editImage(settings, image.prompt, [
        { buffer: readImageFile(body.productId, image.file) },
        { buffer: logo },
      ])
    )
  } else {
    buf = await runAi(() => generateImage(settings, image.prompt))
  }
  // 重生成主图同样统一成纯白背景
  if (image.kind === 'main') buf = await finalizeMainImage(buf)
  if (image.kind === 'dimension' && image.dimensionSpec) {
    buf = await overlayDimensions(buf, image.dimensionSpec)
  }

  const file = saveImageFile(body.productId, buf)
  db.prepare('UPDATE product_images SET file=?, updated_at=? WHERE id=?').run(
    file,
    new Date().toISOString(),
    image.id
  )
  res.json({
    image: { ...image, file, updatedAt: new Date().toISOString() },
    url: `/api/product-images/${body.productId}/${file}`,
  })
})

