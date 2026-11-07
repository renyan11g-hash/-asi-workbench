/**
 * 一次性数据管理接口（2026-11-07 迁移用）。
 *
 * 这次要做两件不可逆的事：删掉 19 个没进正式产品库的产品、把 75 个已上架产品重编成 GLS0001…；
 * 所以都放在这里，并且：
 *   ① 必须先调 /backup 拿到「将被删除的原始行」再做（接口不强制，但界面流程是这么走的）；
 *   ② 必须带确认串（RENUMBER-75），手滑点错不会执行；
 *   ③ 用 settings 里的标记做成幂等，重复调用不会二次编号。
 */

import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db, getSetting, setSetting } from '../db'
import { AppError } from '../middleware/errorHandler'
import { renumberToGls, syncGlsSeq } from '../services/numbering'

export const adminRouter: Router = Router()

const FLAG_KEY = 'admin:gls-renumber-v1'
const CONFIRM = 'RENUMBER-75'

/** 迁移现状（页面显示用） */
adminRouter.get('/migration-status', (_req: Request, res: Response) => {
  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM products GROUP BY status')
    .all() as unknown as Array<{ status: string; n: number }>
  const total = counts.reduce((s, c) => s + Number(c.n), 0)
  const listed = Number(counts.find((c) => c.status === 'listed')?.n ?? 0)
  res.json({
    done: getSetting(FLAG_KEY) ?? null,
    total,
    listed,
    willDelete: total - listed,
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    glsSeq: Number(getSetting('gls-seq') ?? 0),
  })
})

/**
 * 备份：把「将被删除」的产品整行导出成 JSON（含图片、评估、文案）。
 * 导出的文件请自己存好 —— 删除之后这是唯一的原始副本。
 */
adminRouter.get('/backup', (_req: Request, res: Response) => {
  const rows = db.prepare("SELECT * FROM products WHERE status != 'listed'").all() as unknown as Array<
    Record<string, unknown>
  >
  const images = db
    .prepare(
      `SELECT pi.* FROM product_images pi JOIN products p ON p.id = pi.product_id WHERE p.status != 'listed'`
    )
    .all() as unknown as Array<Record<string, unknown>>
  const reviews = db
    .prepare(
      `SELECT lr.* FROM listing_reviews lr JOIN products p ON p.id = lr.product_id WHERE p.status != 'listed'`
    )
    .all() as unknown as Array<Record<string, unknown>>
  const specs = db
    .prepare(
      `SELECT ps.* FROM product_specs ps JOIN products p ON p.id = ps.product_id WHERE p.status != 'listed'`
    )
    .all() as unknown as Array<Record<string, unknown>>
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="asi-backup-${new Date().toISOString().slice(0, 10)}.json"`
  )
  res.send(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        note: '即将被删除的产品（status != listed）及其图片/审核/结构化资料，原样备份',
        products: rows,
        productImages: images,
        listingReviews: reviews,
        productSpecs: specs,
      },
      null,
      2
    )
  )
})

/** 只读预览：75 个产品会变成哪些号 */
adminRouter.get('/renumber-preview', (_req: Request, res: Response) => {
  const rows = db
    .prepare(
      "SELECT id, code, source_title, created_at FROM products WHERE status = 'listed' ORDER BY created_at ASC, code ASC"
    )
    .all() as unknown as Array<{ id: string; code: string; source_title: string; created_at: string }>
  res.json({
    total: rows.length,
    rows: rows.map((r, i) => ({
      productId: r.id,
      title: r.source_title,
      oldCode: r.code,
      newCode: `GLS${String(i + 1).padStart(4, '0')}`,
      createdAt: r.created_at,
    })),
  })
})

/**
 * 执行迁移：删除非 listed 的产品 + 把 listed 的按加入顺序重编 GLS。
 * 幂等：跑过一次就返回 alreadyDone，不会再删再编。
 */
adminRouter.post('/migrate-gls', (req: Request, res: Response) => {
  const body = z.object({ confirm: z.string() }).parse(req.body ?? {})
  if (body.confirm.trim() !== CONFIRM) {
    throw new AppError(400, `确认串不对。要执行请输入 ${CONFIRM}`)
  }
  const done = getSetting(FLAG_KEY)
  if (done) {
    res.json({ ok: true, alreadyDone: true, doneAt: done })
    return
  }

  const all = db.prepare('SELECT id, status FROM products').all() as unknown as Array<{
    id: string
    status: string
  }>
  const toDelete = all.filter((p) => p.status !== 'listed')
  const kept = all.filter((p) => p.status === 'listed')

  let deleted = 0
  for (const p of toDelete) {
    try {
      db.prepare('DELETE FROM product_images WHERE product_id = ?').run(p.id)
      db.prepare('DELETE FROM listing_reviews WHERE product_id = ?').run(p.id)
      db.prepare('DELETE FROM product_specs WHERE product_id = ?').run(p.id)
      db.prepare('DELETE FROM products WHERE id = ?').run(p.id)
      deleted += 1
    } catch {
      /* 单条失败继续，最后看计数 */
    }
  }

  const renumbered = renumberToGls()
  const now = new Date().toISOString()
  setSetting(FLAG_KEY, now)
  syncGlsSeq(renumbered.lastSeq)

  res.json({
    ok: true,
    deleted,
    renumbered: renumbered.updated,
    nextGls: `GLS${String(renumbered.lastSeq + 1).padStart(4, '0')}`,
    kept: kept.length,
    doneAt: now,
  })
})
