import { randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { syncProductFromDraft } from './products'

/**
 * 选品评估草稿：
 * 用户在「选品评估」页填写 1688 基础信息（材质/尺寸/箱规/卖点等），
 * 可随时保存草稿，防止刷新/关页后数据丢失。
 * content 为前端表单的完整 JSON 快照，后端不做结构约束（透传存储）。
 */

interface DraftRow {
  id: string
  title: string
  content: string
  created_at: string
  updated_at: string
}

export interface DraftMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface Draft extends DraftMeta {
  content: Record<string, unknown>
}

const draftsRouter: Router = Router()

const upsertSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(200).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
})

function rowToDraft(r: DraftRow): Draft {
  let content: Record<string, unknown> = {}
  try {
    content = JSON.parse(r.content) as Record<string, unknown>
  } catch {
    content = {}
  }
  return {
    id: r.id,
    title: r.title,
    content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function findDraft(id: string): DraftRow | undefined {
  return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined
}

/** 草稿列表（按更新时间倒序，不含 content，轻量） */
draftsRouter.get('/', async (_req: Request, res: Response) => {
  const rows = db
    .prepare('SELECT id, title, created_at, updated_at FROM drafts ORDER BY updated_at DESC')
    .all() as unknown as Omit<DraftRow, 'content'>[]
  res.json({
    drafts: rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  })
})

/** 读取单个草稿（含完整表单内容） */
draftsRouter.get('/:id', async (req: Request, res: Response) => {
  const row = findDraft(req.params.id)
  if (!row) throw new AppError(404, '草稿不存在')
  res.json({ draft: rowToDraft(row) })
})

/** 保存草稿（有 id 则覆盖更新，无 id 则新建）；内容变更时同步到已关联的产品 */
draftsRouter.post('/', async (req: Request, res: Response) => {
  const body = upsertSchema.parse(req.body ?? {})
  const now = new Date().toISOString()
  const id = body.id?.trim() || randomUUID()
  const existing = findDraft(id)
  if (existing) {
    const title = body.title !== undefined ? body.title : existing.title
    const content = body.content !== undefined ? JSON.stringify(body.content) : existing.content
    db.prepare('UPDATE drafts SET title = ?, content = ?, updated_at = ? WHERE id = ?').run(
      title,
      content,
      now,
      id
    )
  } else {
    db.prepare(
      'INSERT INTO drafts (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, body.title ?? '', JSON.stringify(body.content ?? {}), now, now)
  }
  const row = findDraft(id)
  if (!row) throw new AppError(500, '草稿保存失败')
  // 评估库草稿数据变更 → 同步 source/evaluation 到关联产品（评估库 → 产品库）
  let syncedProductId: string | null = null
  if (body.content) {
    try {
      const synced = syncProductFromDraft(id, rowToDraft(row).content)
      syncedProductId = synced?.id ?? null
    } catch {
      // 同步失败不影响草稿保存本身
    }
  }
  res.json({ draft: rowToDraft(row), syncedProductId })
})

/** 删除草稿 */
draftsRouter.delete('/:id', async (req: Request, res: Response) => {
  const info = db.prepare('DELETE FROM drafts WHERE id = ?').run(req.params.id)
  if (!info.changes) throw new AppError(404, '草稿不存在')
  res.json({ ok: true })
})

export { draftsRouter }
