/**
 * 产品流水线（统一产品档案）。
 *
 * 这个模块解决的是「模块各管各的、每个产品处理到哪一步全靠人记」的问题：
 * 整个系统里**一个产品只有一条档案**（products 表里一行，带 RPA 编号），
 *   资料录入 → AI 评估 → 英文文案 → 人工审核 → 正式产品库
 * 都在这同一行上推进，状态只变一次、数据只存一份。
 *
 * 因此这里不产生任何新数据，只做三件事：
 *   ① 把每条档案的「每一步做到哪」算出来给前端看（资料/评估/文案/图片/状态/下一步）；
 *   ② 给总览页出漏斗计数（待补资料 / 待评估 / 待生成文案 / 待审核 / 正式产品）；
 *   ③ 待审核 = status='pending_review' 的那些档案，通过/驳回直接改这条档案的状态。
 *
 * 评分、印刷方式、报价、图片规则一律不在这里重算 —— 全部沿用单品流程的函数。
 */

import { Router, Request, Response } from 'express'
import { z } from 'zod'
import Jimp from 'jimp'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { enterPreLibrary } from '../services/library'

export const flowRouter: Router = Router()

/** 流水线上的一行（轻量：不带 images / evaluation / listing 大字段） */
interface LiteRow {
  id: string
  code: string
  source_title: string
  source_url: string
  size_cn: string
  weight_g: number | null
  carton_l_cm: number | null
  carton_w_cm: number | null
  carton_h_cm: number | null
  pcs_per_carton: number | null
  carton_gw_kg: number | null
  price_cny: number | null
  material_cn: string
  colors_cn: string
  score: number | null
  verdict: string | null
  has_eval: number
  has_listing: number
  listing_title: string
  has_src_images: number
  status: string
  review_note: string | null
  updated_at: string
  eval_review: string | null
  library_state: string | null
  gls_code: string | null
  prev_code: string | null
}

/** 评估前必须齐的字段（与批量层 missingFields 同一套口径，标签也是同一批中文） */
function specsMissing(r: LiteRow): string[] {
  const missing: string[] = []
  if (!(Number(r.price_cny) > 0)) missing.push('采购价')
  if (!(r.size_cn ?? '').trim()) missing.push('产品尺寸')
  if (!(r.material_cn ?? '').trim()) missing.push('材质')
  if (!(r.carton_l_cm && r.carton_w_cm && r.carton_h_cm)) missing.push('箱规')
  if (!r.pcs_per_carton) missing.push('每箱数量')
  if (!r.carton_gw_kg) missing.push('箱毛重')
  if (!r.weight_g) missing.push('单件净重')
  if (!r.has_src_images) missing.push('产品图片')
  return missing
}

/** 下一步该做什么：前端按这个给「一键到下一步」的按钮 */
type NextStep =
  | 'specs'
  | 'evaluate'
  | 'evalReview'
  | 'parked'
  | 'listing'
  | 'review'
  | 'confirm'
  | 'done'
  | 'rejected'
  | 'trashed'


function nextStepOf(r: LiteRow, missing: string[]): NextStep {
  if (r.status === 'trashed') return 'trashed'
  if (r.status === 'pending_review') return 'review'
  if (r.status === 'listed') return 'done'
  if (r.status === 'archived') return 'rejected'
  // status='sourced'：档案在流水线中
  if (!r.has_eval) return missing.length ? 'specs' : 'evaluate'
  // 评估跑完了：等人工决定「通过」（通过会自动去生成文案）还是「待定」
  if (r.eval_review === 'pending') return 'evalReview'
  if (r.eval_review === 'rejected') return 'parked'
  if (!r.has_listing) return 'listing'
  // 有文案但还没确认（老数据：以前生成完直接就是 sourced）
  return 'confirm'
}

function liteRows(): LiteRow[] {
  const rows = db
    .prepare(
      `SELECT id, code, source_title, source_url, size_cn, weight_g,
              carton_l_cm, carton_w_cm, carton_h_cm, pcs_per_carton, carton_gw_kg,
              price_cny, material_cn, colors_cn, score, verdict,
              CASE WHEN evaluation IS NULL THEN 0 ELSE 1 END AS has_eval,
              CASE WHEN listing IS NULL THEN 0 ELSE 1 END AS has_listing,
              listing_title, status, review_note, updated_at, eval_review, library_state, gls_code, prev_code,
              CASE WHEN images NOT IN ('', '[]') THEN 1 ELSE 0 END AS has_src_images
       FROM products
       WHERE status != 'trashed'
       ORDER BY updated_at DESC`
    )
    .all() as unknown as LiteRow[]
  return rows
}

/** 每条档案的 AI 生成图数量 + 第一张图的文件（列表里当缩略图） */
function imageIndex(): {
  count: Map<string, number>
  first: Map<string, string>
} {
  const count = new Map<string, number>()
  const first = new Map<string, string>()
  try {
    const rows = db
      .prepare('SELECT product_id, file FROM product_images ORDER BY slot ASC, created_at ASC')
      .all() as unknown as Array<{ product_id: string; file: string }>
    for (const r of rows) {
      count.set(r.product_id, (count.get(r.product_id) ?? 0) + 1)
      if (!first.has(r.product_id)) first.set(r.product_id, r.file)
    }
  } catch {
    // 表还没建好（首次启动）：当作没有生成图
  }
  return { count, first }
}

function toFlowRow(r: LiteRow, imgs: { count: Map<string, number>; first: Map<string, string> }) {
  const missing = specsMissing(r)
  const aiImages = imgs.count.get(r.id) ?? 0
  const firstFile = imgs.first.get(r.id)
  return {
    id: r.id,
    code: r.code || '',
    title: r.source_title || '',
    titleEn: r.listing_title || '',
    sourceUrl: r.source_url || '',
    status: r.status,
    score: r.score ?? null,
    verdict: r.verdict ?? null,
    reviewNote: r.review_note ?? '',
    updatedAt: r.updated_at,
    /** 评估人工审核结果（产品评估这一站） */
    evalReview: r.eval_review ?? null,
    /** pipeline / pre（预产品库）/ rpa（RPA 档案库） */
    libraryState: r.library_state ?? 'pipeline',
    glsCode: r.gls_code ?? null,
    prevCode: r.prev_code ?? null,
    specs: {
      missing,
      complete: missing.length === 0,
      /** 影响评估可信度的核心字段（缺了分数会骗人） */
      criticalMissing: missing.filter((m) => m !== '产品图片' && m !== '单件净重'),
    },
    hasEval: Boolean(r.has_eval),
    hasListing: Boolean(r.has_listing),
    images: {
      ai: aiImages,
      source: Boolean(r.has_src_images),
      // 有 AI 生成图的优先用生成图（它是 1200×1200 的成品），否则回落到原始图缩略图
      thumb: firstFile ? `/api/product-images/${r.id}/${firstFile}` : '',
      thumbFallback:
        r.has_src_images && !firstFile
          ? `/api/flow/thumb/${r.id}?v=${encodeURIComponent(r.updated_at)}`
          : '',
    },
    nextStep: nextStepOf(r, missing),
  }
}

/** 总览：一条流水线各站的人数 */
flowRouter.get('/overview', (_req: Request, res: Response) => {
  const rows = liteRows()
  const imgs = imageIndex()
  const count = (fn: (r: LiteRow) => boolean) => rows.filter(fn).length
  const sourced = (r: LiteRow) => r.status === 'sourced'
  const missingOf = (r: LiteRow) => specsMissing(r)
  const noEval = (r: LiteRow) => sourced(r) && !r.has_eval
  const withImages = rows.filter((r) => (imgs.count.get(r.id) ?? 0) > 0).length

  res.json({
    total: rows.length,
    /** 待补资料：还没评估，且关键字段不全 */
    needSpecs: count((r) => noEval(r) && missingOf(r).length > 0),
    /** 待评估：资料齐了，还没跑 AI 评估 */
    needEval: count((r) => noEval(r) && missingOf(r).length === 0),
    /** 评估跑完、等人工定通过/待定 */
    needEvalReview: count((r) => sourced(r) && Boolean(r.has_eval) && r.eval_review === 'pending'),
    /** 评估没通过（待定） */
    parked: count((r) => sourced(r) && r.eval_review === 'rejected'),
    /** 待生成文案：评估结论已经定了（通过或没走评估审核的老数据）、还没英文链接 */
    needListing: count(
      (r) =>
        sourced(r) &&
        Boolean(r.has_eval) &&
        r.eval_review !== 'pending' &&
        r.eval_review !== 'rejected' &&
        !r.has_listing
    ),
    /** 待审核 */
    pendingReview: count((r) => r.status === 'pending_review'),
    /** 已生成文案但还没确认保存（老数据） */
    needConfirm: count((r) => sourced(r) && Boolean(r.has_listing) && r.eval_review !== 'rejected'),
    /** 已上架（预产品库 + RPA 档案库） */
    listed: count((r) => r.status === 'listed'),
    /** 预产品库（已发 GLS 号） */
    inPreLibrary: count((r) => r.status === 'listed' && (r.library_state ?? 'pre') !== 'rpa'),
    /** RPA 档案库 */
    inRpaArchive: count((r) => r.library_state === 'rpa'),
    archived: count((r) => r.status === 'archived'),
    /** 有 AI 生成图的档案数 */
    withImages,
    updatedAt: new Date().toISOString(),
  })
})

/** 流水线列表：每条档案的每一步进度 + 下一步 */
flowRouter.get('/products', (req: Request, res: Response) => {
  const need = String(req.query.need ?? 'all')
  const q = String(req.query.q ?? '').trim()
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 300) || 300))

  let rows = liteRows()
  const imgs = imageIndex()

  if (q) {
    const like = q.toLowerCase()
    rows = rows.filter(
      (r) =>
        (r.source_title ?? '').toLowerCase().includes(like) ||
        (r.listing_title ?? '').toLowerCase().includes(like) ||
        (r.code ?? '').toLowerCase().includes(like) ||
        (r.source_url ?? '').toLowerCase().includes(like)
    )
  }

  let mapped = rows.map((r) => toFlowRow(r, imgs))
  if (need !== 'all') {
    const want: Record<string, NextStep[]> = {
      specs: ['specs'],
      evaluate: ['evaluate'],
      listing: ['listing', 'confirm'],
      review: ['review'],
      done: ['done'],
      rejected: ['rejected'],
      open: ['specs', 'evaluate', 'listing', 'confirm', 'review'],
    }
    if (need === 'rpa') {
      mapped = mapped.filter((r) => r.libraryState === 'rpa')
    } else {
      const allow = want[need] ?? null
      if (allow) mapped = mapped.filter((r) => allow.includes(r.nextStep as NextStep))
    }
  }

  res.json({ rows: mapped.slice(0, limit), total: mapped.length })
})

/** 待审核列表：就是档案里 status='pending_review' 的那些（不再是一份独立的数据） */
flowRouter.get('/reviews', (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim().toLowerCase()
  const rows = liteRows().filter((r) => r.status === 'pending_review')
  const imgs = imageIndex()
  const mapped = rows
    .map((r) => toFlowRow(r, imgs))
    .filter((r) => !q || r.title.toLowerCase().includes(q) || r.titleEn.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
  res.json({ reviews: mapped, total: mapped.length })
})

/** 批量审核通过 / 驳回：改的就是这条档案的状态，没有第二份数据要同步 */
flowRouter.post('/reviews/approve', (req: Request, res: Response) => {
  const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).parse(req.body ?? {})
  const now = new Date().toISOString()
  const approved: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const id of body.ids) {
    try {
      const row = db.prepare('SELECT status FROM products WHERE id = ?').get(id) as { status: string } | undefined
      if (!row) {
        failed.push({ id, error: '档案不存在' })
        continue
      }
      if (row.status !== 'pending_review') {
        failed.push({ id, error: '这条不在待审核状态（可能已通过或已驳回）' })
        continue
      }
      db.prepare(
        "UPDATE products SET status='listed', review_state='approved', reviewed_at=?, updated_at=? WHERE id=?"
      ).run(now, now, id)
      // 进预产品库即发 GLS 号（已有号不重发）
      try {
        enterPreLibrary(id)
      } catch {
        /* 发号失败不影响审核本身 */
      }
      // 批量任务靠 listing_reviews 判断这条审核结果，这里同步（没有对应记录也不影响）
      db.prepare(
        "UPDATE listing_reviews SET status='approved', updated_at=? WHERE product_id=? AND status='pending'"
      ).run(now, id)
      approved.push(id)
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  res.json({ ok: true, approved, failed })
})

flowRouter.post('/reviews/reject', (req: Request, res: Response) => {
  const body = z
    .object({ ids: z.array(z.string().min(1)).min(1).max(200), note: z.string().max(500).optional() })
    .parse(req.body ?? {})
  const note = body.note ?? ''
  const now = new Date().toISOString()
  let n = 0
  for (const id of body.ids) {
    const row = db.prepare('SELECT status FROM products WHERE id = ?').get(id) as { status: string } | undefined
    if (!row || row.status !== 'pending_review') continue
    db.prepare(
      "UPDATE products SET status='archived', review_state='rejected', review_note=?, reviewed_at=?, updated_at=? WHERE id=?"
    ).run(note, now, now, id)
    db.prepare(
      "UPDATE listing_reviews SET status='rejected', review_note=?, updated_at=? WHERE product_id=? AND status='pending'"
    ).run(note, now, id)
    n += 1
  }
  res.json({ ok: true, rejected: n })
})

/**
 * 退回到「待生成文案」：驳回后想改资料重做，或误点了通过。
 * 只动状态，不删档案，资料/评估/图片全部保留。
 */
flowRouter.post('/reviews/reopen', (req: Request, res: Response) => {
  const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).parse(req.body ?? {})
  const now = new Date().toISOString()
  let n = 0
  for (const id of body.ids) {
    const row = db.prepare('SELECT status FROM products WHERE id = ?').get(id) as { status: string } | undefined
    if (!row) continue
    db.prepare(
      "UPDATE products SET status='sourced', listing=NULL, listing_title='', review_state=NULL, review_note='', updated_at=? WHERE id=?"
    ).run(now, id)
    db.prepare("DELETE FROM listing_reviews WHERE product_id=? AND status != 'approved'").run(id)
    n += 1
  }
  res.json({ ok: true, reopened: n })
})

/**
 * 档案缩略图：产品原始图存的是 data URL（1688 图有防盗链，只能内联），
 * 列表里直接塞几十张 data URL 会把响应撑到几十 MB，所以这里缩到 96px 再返回。
 */
const thumbCache = new Map<string, { key: string; buf: Buffer }>()

flowRouter.get('/thumb/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id)
  const row = db.prepare('SELECT images, updated_at FROM products WHERE id = ?').get(id) as
    | { images: string; updated_at: string }
    | undefined
  if (!row) throw new AppError(404, '档案不存在')
  let images: string[] = []
  try {
    images = JSON.parse(row.images ?? '[]') as string[]
  } catch {
    images = []
  }
  const src = images.find((u) => typeof u === 'string' && u.startsWith('data:'))
  if (!src) throw new AppError(404, '这条档案没有内联产品图')

  const key = `${row.updated_at}:${src.length}`
  const hit = thumbCache.get(id)
  if (hit && hit.key === key) {
    res.type('image/jpeg').send(hit.buf)
    return
  }

  const base64 = src.split(',')[1] ?? ''
  if (!base64) throw new AppError(400, '图片内容为空')
  const raw = Buffer.from(base64, 'base64')
  const img = await Jimp.read(raw)
  img.cover(96, 96)
  const buf = await img.quality(72).getBufferAsync(Jimp.MIME_JPEG)
  thumbCache.set(id, { key, buf })
  res.type('image/jpeg').send(buf)
})
