import { randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'

/**
 * 历史选品：选品预估页「快速评估」每次成功评估后自动落库（按 1688 链接去重，
 * 重复评估同一链接会覆盖更新），供回看评估结果、重新带入产品信息预填、删除。
 */

interface HistoryRow {
  id: string
  url: string
  title: string
  score: number | null
  verdict: string | null
  source: string
  fetched: string
  evaluation: string
  price_grid: string
  created_at: string
  updated_at: string
}

export interface SourcingHistoryRecord {
  id: string
  url: string
  title: string
  score: number | null
  verdict: string | null
  source: Record<string, unknown>
  fetched: Record<string, unknown>
  evaluation: Record<string, unknown>
  priceGrid: unknown[]
  createdAt: string
  updatedAt: string
}

export const sourcingHistoryRouter: Router = Router()

const parseJson = <T>(v: string, fallback: T): T => {
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

function rowToRecord(r: HistoryRow): SourcingHistoryRecord {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    score: r.score,
    verdict: r.verdict,
    source: parseJson(r.source, {}),
    fetched: parseJson(r.fetched, {}),
    evaluation: parseJson(r.evaluation, {}),
    priceGrid: parseJson(r.price_grid, [] as unknown[]),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 保存/更新一条历史选品记录（按 url 去重）；失败由调用方兜底，不影响主流程 */
export function saveSourcingHistory(input: {
  url: string
  title: string
  score: number | null
  verdict: string | null
  source: unknown
  fetched: unknown
  evaluation: unknown
  priceGrid: unknown
}): void {
  const now = new Date().toISOString()
  const existing = db.prepare('SELECT id FROM sourcing_history WHERE url = ?').get(input.url) as
    | { id: string }
    | undefined
  if (existing) {
    db.prepare(
      'UPDATE sourcing_history SET title=?, score=?, verdict=?, source=?, fetched=?, evaluation=?, price_grid=?, updated_at=? WHERE id=?'
    ).run(
      input.title,
      input.score,
      input.verdict,
      JSON.stringify(input.source ?? {}),
      JSON.stringify(input.fetched ?? {}),
      JSON.stringify(input.evaluation ?? {}),
      JSON.stringify(input.priceGrid ?? []),
      now,
      existing.id
    )
  } else {
    db.prepare(
      'INSERT INTO sourcing_history (id, url, title, score, verdict, source, fetched, evaluation, price_grid, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      randomUUID(),
      input.url,
      input.title,
      input.score,
      input.verdict,
      JSON.stringify(input.source ?? {}),
      JSON.stringify(input.fetched ?? {}),
      JSON.stringify(input.evaluation ?? {}),
      JSON.stringify(input.priceGrid ?? []),
      now,
      now
    )
  }
}

/** 历史选品列表（全量字段，数据量小，按更新时间倒序） */
sourcingHistoryRouter.get('/', async (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM sourcing_history ORDER BY updated_at DESC').all() as unknown as HistoryRow[]
  res.json({ items: rows.map(rowToRecord) })
})

/** 删除一条历史选品记录 */
sourcingHistoryRouter.delete('/:id', async (req: Request, res: Response) => {
  const r = db.prepare('DELETE FROM sourcing_history WHERE id = ?').run(String(req.params.id))
  if (r.changes === 0) throw new AppError(404, '历史记录不存在')
  res.json({ ok: true })
})
