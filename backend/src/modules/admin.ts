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
import { sanitizeProductCopy, singleParagraph } from '../services/listing-copy'
import { LIMITS } from '../constants/asi'

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


/**
 * 存量文案清理：把已经有英文链接的产品，按「详细描述只描述产品」规则重新清洗一遍。
 *
 * 为什么需要：规则是 2026-11-10 才加进生成链路的，之前生成的那批文案里还留着
 * 「发货快 / 运费低 / 打样方便 / 60 grams / carton 尺寸」这类句子，用户看到的还是老文案。
 * 这里不调 AI、不重写措辞，只整句剔除违规内容并压成单段落，所以：
 *   - 默认 dryRun：只统计会改哪几条、删了哪些句子，不写库；
 *   - 传 apply=true 才写回，并把删掉的句子记进该 listing 的 qc.issues，界面上能看到改动。
 */
adminRouter.post('/clean-descriptions', (req: Request, res: Response) => {
  const body = z
    .object({ apply: z.boolean().optional(), limit: z.coerce.number().min(1).max(2000).optional() })
    .parse(req.body ?? {})
  const rows = db
    .prepare("SELECT id, code, listing FROM products WHERE listing IS NOT NULL AND listing <> '' ORDER BY code")
    .all() as unknown as Array<{ id: string; code: string; listing: string }>

  const changed: Array<{ code: string; removed: string[]; beforeLen: number; afterLen: number }> = []
  const now = new Date().toISOString()
  let written = 0

  for (const r of rows) {
    let listing: Record<string, unknown>
    try {
      listing = JSON.parse(r.listing) as Record<string, unknown>
    } catch {
      continue
    }
    const before = typeof listing.description === 'string' ? listing.description : ''
    if (!before) continue
    const { text, removed } = sanitizeProductCopy(before, LIMITS.description)
    const after = singleParagraph(text)
    if (!removed.length && after === before) continue

    changed.push({ code: r.code, removed, beforeLen: before.length, afterLen: after.length })
    if (body.apply) {
      listing.description = after
      // 记一笔：界面 QC 卡会显示「已清理」，不至于内容悄悄变了没人知道
      const qc = (listing.qc ?? {}) as Record<string, unknown>
      const issues = Array.isArray(qc.issues) ? (qc.issues as unknown[]).map(String) : []
      const note = `已按「只描述产品」规则清理 ${removed.length} 句运输/克重/箱规内容`
      if (!issues.includes(note)) issues.push(note)
      listing.qc = { ...qc, issues }
      db.prepare('UPDATE products SET listing = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(listing),
        now,
        r.id
      )
      written += 1
    }
    if (body.limit && changed.length >= body.limit) break
  }

  // 待审核中心里的文案也一起清：这些记录批准后会直接变成产品链接，不能留旧话术
  const reviewRows = db
    .prepare("SELECT id, listing FROM listing_reviews WHERE listing IS NOT NULL AND listing <> ''")
    .all() as unknown as Array<{ id: string; listing: string }>
  let reviewChanged = 0
  let reviewWritten = 0
  for (const r of reviewRows) {
    let listing: Record<string, unknown>
    try {
      listing = JSON.parse(r.listing) as Record<string, unknown>
    } catch {
      continue
    }
    const before = typeof listing.description === 'string' ? listing.description : ''
    if (!before) continue
    const { text, removed } = sanitizeProductCopy(before, LIMITS.description)
    const after = singleParagraph(text)
    if (!removed.length && after === before) continue
    reviewChanged += 1
    if (body.apply) {
      listing.description = after
      db.prepare('UPDATE listing_reviews SET listing = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(listing),
        now,
        r.id
      )
      reviewWritten += 1
    }
  }

  res.json({
    ok: true,
    scanned: rows.length,
    changed: changed.length,
    written,
    reviewScanned: reviewRows.length,
    reviewChanged,
    reviewWritten,
    applied: Boolean(body.apply),
    samples: changed.slice(0, 12).map((c) => ({
      code: c.code,
      beforeLen: c.beforeLen,
      afterLen: c.afterLen,
      removed: c.removed.slice(0, 4).map((s) => s.slice(0, 160)),
    })),
  })
})