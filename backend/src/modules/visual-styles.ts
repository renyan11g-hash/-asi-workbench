import { Router, Request, Response } from 'express'
import { z } from 'zod'
import {
  FEEDBACK_REASONS,
  VISUAL_CATEGORIES,
  VISUAL_CATEGORY_LABEL,
  addVisualRef,
  autoMatchProduct,
  collectGeneratedImage,
  createVisualStyle,
  deleteVisualRef,
  deleteVisualStyle,
  feedbackSummary,
  getCachedMatch,
  getVisualRef,
  getVisualStyle,
  learnVisualStyle,
  listVisualRefs,
  listVisualStyles,
  updateVisualRef,
  updateVisualStyle,
  visualRefBuffer,
} from '../services/visual-styles'
import { capabilitiesFor } from '../services/image-fidelity'
import { loadSettings } from './settings'
import { findProduct } from './products'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'

/**
 * 视觉风格中心 API。
 *
 * 页面用到的全部数据都在这里：
 *   参考图库（上传 / 导 URL / 从历史生成图收藏 / 收藏 / 启停 / 优秀·不合格 / 备注）
 *   风格配置（AI 学习、人工改、默认风格、版本）
 *   自动匹配状态（产品品类识别 + 命中风格，落库缓存）
 *   反馈汇总（哪种原因最常被吐槽，用于改进风格）
 */

export const visualStylesRouter: Router = Router()

visualStylesRouter.get('/capabilities', (_req: Request, res: Response) => {
  const s = loadSettings()
  res.json({ capabilities: capabilitiesFor(s.imageBaseUrl, s.imageModel) })
})

visualStylesRouter.get('/meta', (_req: Request, res: Response) => {
  res.json({
    categories: VISUAL_CATEGORIES.map((k) => ({ key: k, label: VISUAL_CATEGORY_LABEL[k] })),
    feedbackReasons: FEEDBACK_REASONS,
  })
})

/* ---------------- 参考图库 ---------------- */

visualStylesRouter.get('/refs', (req: Request, res: Response) => {
  const q = z
    .object({
      category: z.string().optional(),
      status: z.string().optional(),
      verdict: z.string().optional(),
      favorite: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().positive().max(500).optional(),
    })
    .parse(req.query ?? {})
  res.json({ refs: listVisualRefs(q) })
})

/** 参考图文件（图片真身存 DB，部署后不丢） */
visualStylesRouter.get('/refs/:id/image', (req: Request, res: Response) => {
  const ref = getVisualRef(String(req.params.id))
  const row = db.prepare('SELECT mime FROM visual_refs WHERE id = ?').get(ref.id) as unknown as
    | { mime: string }
    | undefined
  res.setHeader('Content-Type', row?.mime || 'image/png')
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.send(visualRefBuffer(ref.id))
})

/** 上传参考图（前端读成 dataURL 传过来；批量时逐张调用） */
visualStylesRouter.post('/refs', async (req: Request, res: Response) => {
  const body = z
    .object({
      dataUrl: z.string().max(8_000_000).optional(),
      url: z.string().max(4000).optional(),
      category: z.string().max(40).optional(),
      title: z.string().max(200).optional(),
      note: z.string().max(1000).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      verdict: z.enum(['good', 'ok', 'bad']).optional(),
      favorite: z.boolean().optional(),
      origin: z.string().max(30).optional(),
      sourceUrl: z.string().max(4000).optional(),
    })
    .parse(req.body ?? {})
  if (!body.dataUrl && !body.url) throw new AppError(400, '缺少图片（dataUrl 或 url）')
  const ref = await addVisualRef({
    dataUrl: body.dataUrl,
    url: body.url,
    category: body.category,
    title: body.title,
    note: body.note,
    tags: body.tags,
    verdict: body.verdict,
    favorite: body.favorite,
    origin: body.origin || (body.url ? 'url' : 'upload'),
    sourceUrl: body.sourceUrl || body.url || '',
  })
  res.json({ ref })
})

/** 从历史生成图收藏（不重新上传，复制真身进视觉库） */
visualStylesRouter.post('/refs/from-generated', async (req: Request, res: Response) => {
  const body = z
    .object({
      productId: z.string().min(1),
      imageId: z.string().min(1),
      category: z.string().max(40).optional(),
      title: z.string().max(200).optional(),
      note: z.string().max(1000).optional(),
      verdict: z.enum(['good', 'ok', 'bad']).optional(),
    })
    .parse(req.body ?? {})
  const ref = await collectGeneratedImage(body)
  res.json({ ref })
})

visualStylesRouter.patch('/refs/:id', (req: Request, res: Response) => {
  const body = z
    .object({
      category: z.string().max(40).optional(),
      title: z.string().max(200).optional(),
      note: z.string().max(1000).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      verdict: z.enum(['good', 'ok', 'bad']).optional(),
      status: z.enum(['active', 'inactive']).optional(),
      favorite: z.boolean().optional(),
    })
    .parse(req.body ?? {})
  res.json({ ref: updateVisualRef(String(req.params.id), body) })
})

visualStylesRouter.delete('/refs/:id', (req: Request, res: Response) => {
  deleteVisualRef(String(req.params.id))
  res.json({ ok: true })
})

/** 最近生成的图片（「收藏到优秀作品库」的候选） */
visualStylesRouter.get('/generated-candidates', (req: Request, res: Response) => {
  const q = z.object({ limit: z.coerce.number().int().positive().max(120).optional() }).parse(req.query ?? {})
  const limit = Math.max(1, Math.min(q.limit ?? 40, 120))
  interface Row {
    product_id: string
    image_id: string
    kind: string
    file: string
    created_at: string
    code: string
    source_title: string
  }
  const rows = db
    .prepare(
      `SELECT pi.product_id, pi.id AS image_id, pi.kind, pi.file, pi.created_at,
              COALESCE(p.code, '') AS code, COALESCE(p.source_title, '') AS source_title
       FROM product_images pi LEFT JOIN products p ON p.id = pi.product_id
       WHERE pi.archived = 0
       ORDER BY pi.created_at DESC LIMIT ${limit}`
    )
    .all() as unknown as Row[]
  res.json({
    candidates: rows.map((r) => {
      const collected = db
        .prepare('SELECT id FROM visual_refs WHERE product_id = ? AND image_id = ? LIMIT 1')
        .get(r.product_id, r.image_id) as unknown as { id: string } | undefined
      return {
        productId: r.product_id,
        productCode: r.code,
        sourceTitle: r.source_title,
        imageId: r.image_id,
        kind: r.kind,
        url: `/api/product-images/${r.product_id}/${r.file}`,
        createdAt: r.created_at,
        collectedRefId: collected?.id ?? null,
      }
    }),
  })
})

/* ---------------- 风格配置 ---------------- */

visualStylesRouter.get('/styles', (_req: Request, res: Response) => {
  res.json({ styles: listVisualStyles() })
})

visualStylesRouter.get('/styles/:id', (req: Request, res: Response) => {
  res.json({ style: getVisualStyle(String(req.params.id)) })
})

visualStylesRouter.post('/styles', (req: Request, res: Response) => {
  const body = z
    .object({
      name: z.string().min(1).max(120),
      scope: z.enum(['global', 'category']).optional(),
      category: z.string().max(200).optional(),
      note: z.string().max(2000).optional(),
      promptBlock: z.string().max(8000).optional(),
      isDefault: z.boolean().optional(),
    })
    .parse(req.body ?? {})
  res.json({ style: createVisualStyle(body) })
})

/** AI 学习：看参考图 → 结构化风格配置。传 styleId 则更新该风格并 version+1 */
visualStylesRouter.post('/styles/learn', async (req: Request, res: Response) => {
  const body = z
    .object({
      name: z.string().min(1).max(120),
      styleId: z.string().optional(),
      category: z.string().max(200).optional(),
      scope: z.enum(['global', 'category']).optional(),
      refIds: z.array(z.string()).max(20).optional(),
      note: z.string().max(2000).optional(),
      productHint: z.string().max(1000).optional(),
    })
    .parse(req.body ?? {})
  const style = await learnVisualStyle({ settings: loadSettings(), ...body })
  res.json({ style })
})

visualStylesRouter.patch('/styles/:id', (req: Request, res: Response) => {
  const body = z
    .object({
      name: z.string().min(1).max(120).optional(),
      scope: z.enum(['global', 'category']).optional(),
      category: z.string().max(200).optional(),
      status: z.enum(['active', 'inactive']).optional(),
      isDefault: z.boolean().optional(),
      note: z.string().max(2000).optional(),
      promptBlock: z.string().max(8000).optional(),
      refIds: z.array(z.string()).max(40).optional(),
      profile: z
        .object({
          summary: z.string().max(2000).optional(),
          categoryFit: z.array(z.string()).max(20).optional(),
          composition: z.string().max(2000).optional(),
          productCoverage: z.string().max(2000).optional(),
          placement: z.string().max(2000).optional(),
          background: z.string().max(2000).optional(),
          palette: z.string().max(2000).optional(),
          lighting: z.string().max(2000).optional(),
          shadow: z.string().max(2000).optional(),
          texture: z.string().max(2000).optional(),
          angle: z.string().max(2000).optional(),
          depthOfField: z.string().max(2000).optional(),
          whitespace: z.string().max(2000).optional(),
          layout: z.string().max(2000).optional(),
          scene: z.string().max(2000).optional(),
          typography: z.string().max(2000).optional(),
          doList: z.array(z.string()).max(20).optional(),
          avoidList: z.array(z.string()).max(20).optional(),
        })
        .optional(),
    })
    .parse(req.body ?? {})
  res.json({ style: updateVisualStyle(String(req.params.id), body) })
})

visualStylesRouter.delete('/styles/:id', (req: Request, res: Response) => {
  deleteVisualStyle(String(req.params.id))
  res.json({ ok: true })
})

/* ---------------- 自动识别 + 匹配 ---------------- */

visualStylesRouter.get('/product/:productId/match', (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  const cached = getCachedMatch(productId)
  if (!cached) {
    res.json({ match: null })
    return
  }
  res.json({ match: cached })
})

visualStylesRouter.post('/product/:productId/match', async (req: Request, res: Response) => {
  const productId = String(req.params.productId)
  const body = z.object({ force: z.boolean().optional() }).parse(req.body ?? {})
  const p = findProduct(productId)
  const match = await autoMatchProduct({
    settings: loadSettings(),
    productId,
    source: p.source,
    force: body.force,
  })
  res.json({ match })
})

/* ---------------- 反馈汇总 ---------------- */

visualStylesRouter.get('/feedback/summary', (_req: Request, res: Response) => {
  res.json(feedbackSummary())
})
