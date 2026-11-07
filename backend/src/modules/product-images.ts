import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db, getSetting, setSetting } from '../db'
import { AppError } from '../middleware/errorHandler'
import { AiError } from '../services/ai'
import { editImage, generateImage, ImageRef, ImageSettings, testImageConnection } from '../services/image-gen'
import { buildImagePromptSet, buildIntroSuggestions, translateImageEditInstruction } from '../services/image-prompts'
import { overlayDimensions } from '../services/dimension-overlay'
import { finalizeMainImage } from '../services/image-post'
import Jimp from 'jimp'
import { ProductImage, ProductImageKind, SourceInfo } from '../types'
import { reviewProductImage } from '../services/image-review'
import { fetch1688Page } from './products'
import { loadSettings } from './settings'
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

function saveImageFile(productId: string, buf: Buffer): string {
  const file = `${Date.now()}-${randomUUID().slice(0, 8)}.png`
  fs.writeFileSync(path.join(productDir(productId), file), buf)
  db.prepare('INSERT INTO image_blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(
    blobKey(productId, file),
    buf
  )
  return file
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

/** 生图前把产品资料读成一段事实清单（特点/颜色/材质/使用场景），让模型先理解再画 */
function buildProductInfoBlock(source: SourceInfo, listingSizeInch?: string): string {
  const lines = [
    source.sourceTitle ? `- Product: ${source.sourceTitle}` : '',
    source.materialCn ? `- Material: ${source.materialCn}` : '',
    source.colorsCn ? `- Colours: ${source.colorsCn}` : '',
    source.sizeCn ? `- Size: ${source.sizeCn}` : listingSizeInch ? `- Size: ${listingSizeInch}` : '',
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
    hasSourceImages: images.some((u) => /^https?:\/\//.test(u) || u.startsWith('data:image')),
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
  const merged = Array.from(new Set([...(p.source.images ?? []), ...fetched]))
  if (added.length) {
    db.prepare('UPDATE products SET images=?, updated_at=? WHERE id=?').run(
      JSON.stringify(merged),
      new Date().toISOString(),
      id
    )
  }
  res.json({
    ok: true,
    added: added.length,
    total: merged.length,
    /** 这次新增的图（前端高亮展示「抓到哪几张」） */
    addedImages: added,
    images: merged,
    message,
  })
})

/** 产品图：手动追加图片地址（1688 抓不到时的兜底） */
productImagesRouter.post('/product/:productId/sources', (req: Request, res: Response) => {
  const id = String(req.params.productId)
  const body = z.object({ urls: z.array(z.string().max(4000)).min(1).max(20) }).parse(req.body ?? {})
  const p = findProduct(id)
  const valid = body.urls
    .map((u) => u.trim())
    .filter((u) => /^(https?:\/\/|data:image\/)/i.test(u))
  const merged = Array.from(new Set([...(p.source.images ?? []), ...valid]))
  db.prepare('UPDATE products SET images=?, updated_at=? WHERE id=?').run(
    JSON.stringify(merged),
    new Date().toISOString(),
    id
  )
  res.json({ images: merged, added: merged.length - (p.source.images ?? []).length })
})

/** 参考图列表 */
productImagesRouter.get('/product/:productId/refs', (req: Request, res: Response) => {
  res.json({ refs: listRefs(String(req.params.productId)) })
})

/** 新增参考图（粘贴 URL / base64） */
productImagesRouter.post('/product/:productId/refs', (req: Request, res: Response) => {
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
    .filter((u) => /^(https?:\/\/|data:image\/)/i.test(u))
  if (!urls.length) throw new AppError(400, '没有可用的图片地址（要 http(s):// 或 data:image 开头）')
  const existing = listRefs(id)
  const room = Math.max(0, 6 - existing.length)
  if (!room) throw new AppError(400, '参考图最多 6 张，先删几张再加')
  const now = new Date().toISOString()
  const stmt = db.prepare(
    'INSERT INTO product_ref_images (id, product_id, url, file, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const u of urls.slice(0, room)) {
    stmt.run(randomUUID(), id, u, '', body.note ?? '', now)
  }
  res.json({ ok: true, refs: listRefs(id), added: Math.min(urls.length, room) })
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

  // 「产品图」才是产品事实基准：只认产品真身图（1688 抓的 / 人工上传的），含 data URL。
  // 「参考图」只学构图/光线/场景，单独传给生图模型，并在提示词里明确禁止改产品。
  const productUrls = (source.images ?? []).filter((u) => /^(https?:\/\/|data:image\/)/i.test(u))
  const styleRefs = listRefs(productId)
    .map((r) => r.url)
    .filter((u) => /^(https?:\/\/|data:image\/)/i.test(u))

  const mainRefs: ImageRef[] = productUrls
    .slice(0, 4)
    .map((u) => ({ url: u }) as ImageRef)
  if (logo && withLogo) mainRefs.push({ buffer: logo })
  const plainRefs: ImageRef[] = productUrls.slice(0, 2).map((u) => ({ url: u }) as ImageRef)
  // 参考图放最后 2 张：模型对「靠后的参考图」通常当风格参考，产品事实仍以前面产品图为准
  const refsWithStyle = (base: ImageRef[]): ImageRef[] => [
    ...base,
    ...styleRefs.slice(0, 2).map((u) => ({ url: u }) as ImageRef),
  ]

  // 生图前先读产品资料（特点/颜色/材质/场景），拼成事实清单交给提示词编排
  const productInfo = buildProductInfoBlock(source, listingSizeInch)

  // 异步任务：5 张图逐张生成耗时 1-5 分钟，同步等待会超 Render 100 秒代理超时（502）
  const task = createTask('generate-product-images')
  const created: ProductImage[] = []
  const now = () => new Date().toISOString()
  // Prompt 集缓存：任务重试时复用，只重新生成失败的图
  let promptSet: Awaited<ReturnType<typeof buildImagePromptSet>> | null = null

  runTask(task, async () => {
    // 1) 文本模型产出全部图片的 Prompt（带产品事实清单 + 参考图；用户注意点融入编排）
    const ps =
      promptSet ??
      (promptSet = await runAi(() =>
        buildImagePromptSet(source, settings, body.notes, withLogo, {
          productInfo,
          styleRefCount: Math.min(styleRefs.length, 2),
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

      let buf = await runAi(() =>
        generateImage(settings, prompt, kind === 'main' ? refsWithStyle(mainRefs) : refsWithStyle(plainRefs))
      )

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
            productImages: productUrls.slice(0, 2),
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
  res.setHeader('Content-Type', 'image/png')
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

