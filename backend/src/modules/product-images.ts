import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db, getSetting, setSetting } from '../db'
import { AppError } from '../middleware/errorHandler'
import { AiError } from '../services/ai'
import { editImage, generateImage, ImageRef, ImageSettings, testImageConnection } from '../services/image-gen'
import { buildImagePromptSet, translateImageEditInstruction } from '../services/image-prompts'
import { overlayDimensions } from '../services/dimension-overlay'
import { ProductImage, ProductImageKind, SourceInfo } from '../types'
import { loadSettings } from './settings'

export const productImagesRouter: Router = Router()

// ---------- 存储目录 ----------
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'images')

function productDir(productId: string): string {
  const dir = path.join(IMAGES_DIR, productId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function saveImageFile(productId: string, buf: Buffer): string {
  const file = `${Date.now()}-${randomUUID().slice(0, 8)}.png`
  fs.writeFileSync(path.join(productDir(productId), file), buf)
  return file
}

function readImageFile(productId: string, file: string): Buffer {
  // 防路径穿越：只允许文件名
  const safe = path.basename(file)
  const fp = path.join(productDir(productId), safe)
  if (!fs.existsSync(fp)) throw new AppError(404, '图片文件不存在')
  return fs.readFileSync(fp)
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
    history: JSON.parse(r.history || '[]'),
    file: r.file,
    dimensionSpec: r.dimension_spec ? JSON.parse(r.dimension_spec) : null,
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

/** 读取 Logo Buffer（无 Logo 返回 null） */
function readLogo(): Buffer | null {
  const file = getLogoFile()
  if (!file) return null
  const fp = path.join(IMAGES_DIR, '_brand', file)
  if (!fs.existsSync(fp)) return null
  return fs.readFileSync(fp)
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
  kinds: z.array(z.enum(['main', 'dimension', 'intro'])).max(5).optional(),
})

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

/** 从 sizeCn / productSizeInch 粗解析 inch 尺寸 */
function parseDimensions(source: SourceInfo, listingSizeInch?: string) {
  const text = [listingSizeInch, source.sizeCn].filter(Boolean).join(' ')
  // 匹配 3.5" W x 4.7" H / 8.9 x 12 x 3.5cm / 3.5*4.7inch 等
  const nums = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:["”]|in|inch|cm|毫米|mm)?/gi)].map((m) => Number(m[1]))
  const isCm = /cm|毫米|mm/i.test(text) && !/in|inch|"/i.test(text)
  const conv = (n: number) => (isCm ? n / 2.54 : n)
  if (nums.length >= 2) {
    return {
      widthIn: conv(nums[0]),
      heightIn: conv(nums[1]),
      depthIn: nums.length >= 3 ? conv(nums[2]) : null,
    }
  }
  return null
}

productImagesRouter.post('/generate', async (req: Request, res: Response) => {
  const body = generateSchema.parse(req.body ?? {})
  const settings = loadSettings()

  // 解析产品：优先 productId，其次请求体 source
  let source: SourceInfo
  let productId: string
  if (body.productId) {
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(body.productId) as
      | { id: string; source: string }
      | undefined
    if (!row) throw new AppError(404, '产品不存在')
    source = JSON.parse(row.source) as SourceInfo
    productId = row.id
  } else if (body.source) {
    source = body.source as unknown as SourceInfo
    productId = 'preview'
  } else {
    throw new AppError(400, '请提供 productId 或 source')
  }

  const dims = body.dimensions ?? parseDimensions(source)
  const kinds = body.kinds ?? ['main', 'dimension', 'intro', 'intro', 'intro']
  const logo = readLogo()

  // 1) 文本模型产出 5 张图 Prompt（带产品参考图 + Logo）
  const promptSet = await runAi(() => buildImagePromptSet(source, settings))

  // 参考图：产品图（https URL 直传，火山引擎免下载）+ Logo（base64）
  const refs: ImageRef[] = (source.images ?? [])
    .filter((u) => /^https?:\/\//.test(u))
    .slice(0, 3)
    .map((u) => ({ url: u }) as ImageRef)
  if (logo) refs.push({ buffer: logo })

  const created: ProductImage[] = []
  const now = () => new Date().toISOString()

  // 2) 逐张生成
  for (const kind of kinds) {
    const isIntro = kind === 'intro'
    const existingIntros = created.filter((c) => c.kind === 'intro').length
    const slot = isIntro ? existingIntros + 1 : 0
    const prompt =
      kind === 'main' ? promptSet.main : kind === 'dimension' ? promptSet.dimension : promptSet.intro[slot - 1]

    let buf = await runAi(() => generateImage(settings, prompt, refs))

    // 尺寸图：程序化叠加 inch 标注
    let dimensionSpec: ProductImage['dimensionSpec'] = null
    if (kind === 'dimension' && dims) {
      const spec = { widthIn: dims.widthIn, heightIn: dims.heightIn, depthIn: dims.depthIn ?? null }
      buf = await overlayDimensions(buf, spec)
      dimensionSpec = spec
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
      createdAt: now(),
      updatedAt: now(),
    }
    db.prepare(
      `INSERT INTO product_images (id, product_id, kind, slot, prompt, history, file, dimension_spec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.productId,
      record.kind,
      record.slot,
      record.prompt,
      JSON.stringify(record.history),
      record.file,
      record.dimensionSpec ? JSON.stringify(record.dimensionSpec) : null,
      record.createdAt,
      record.updatedAt
    )
    created.push(record)
  }

  res.json({ images: created, urls: created.map((c) => `/api/product-images/${productId}/${c.file}`) })
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

  // 2) 用当前图 + Logo 作为参考图进行编辑
  const refs: ImageRef[] = [{ buffer: readImageFile(body.productId, image.file) }]
  const logo = readLogo()
  if (logo && image.kind === 'main') refs.push({ buffer: logo })

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

// ---------- 查询产品图片列表 ----------
productImagesRouter.get('/product/:productId', async (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  res.json({ images: listImages(productId) })
})

// ---------- 读取图片文件 ----------
productImagesRouter.get('/:productId/:file', async (req: Request, res: Response) => {
  const { productId, file } = req.params
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
  if (image.kind === 'main' && logo) {
    // 主图需要 Logo 参考：用旧图 + Logo 编辑重生成
    buf = await runAi(() =>
      editImage(settings, image.prompt, [
        { buffer: readImageFile(body.productId, image.file) },
        { buffer: logo },
      ])
    )
  } else {
    buf = await runAi(() => generateImage(settings, image.prompt))
  }
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

