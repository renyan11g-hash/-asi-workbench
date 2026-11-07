/**
 * 编号体系（2026-11-07）。
 *
 * 两套号：
 *   GLS0001…  预产品库编号。产品第一次进预产品库时发放；一旦发放**不再复用** ——
 *             即使这个产品后来被移进 RPA 档案库、或者被删除，这个号也不会再发给别人。
 *   RPA 新号  进 RPA 档案库时人工输入，覆盖旧编号；旧编号记在 prev_code 里可追溯。
 *
 * 为什么用计数器而不是「最大号 + 1」：
 * 最大号 + 1 在删掉最大号那条之后会把号重新发一遍，违反「不再复用」。
 * 计数器只增不减，存在 settings 表（key='gls-seq'），并带一次「从现有数据校准」的兜底。
 */

import { db, getSetting, setSetting } from '../db'

export const GLS_SEQ_KEY = 'gls-seq'

/** GLS0001 这种格式；序号至少 4 位，超过 9999 自然变 5 位 */
export function formatGls(seq: number): string {
  return `GLS${String(Math.max(1, Math.floor(seq))).padStart(4, '0')}`
}

/** 从 products 现有编号里推算已发出的最大 GLS 号（兜底：settings 丢了也不重号） */
export function maxIssuedGls(): number {
  try {
    const row = db
      .prepare("SELECT gls_code FROM products WHERE gls_code LIKE 'GLS%' ORDER BY gls_code DESC LIMIT 1")
      .get() as { gls_code: string } | undefined
    if (!row?.gls_code) return 0
    const n = Number.parseInt(row.gls_code.replace(/^GLS/i, ''), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** 当前已发到第几号 */
export function currentGlsSeq(): number {
  const stored = Number.parseInt(getSetting(GLS_SEQ_KEY) ?? '', 10)
  const base = Number.isFinite(stored) ? stored : 0
  return Math.max(base, maxIssuedGls())
}

/**
 * 取下一个 GLS 号（立刻写回计数器，宁肯跳号也不重号）。
 * Render 上是单进程顺序执行，加上「取号即落盘」，够用；真并发时也不会有两个相同号从同一次调用里出来。
 */
export function nextGlsCode(): string {
  const next = currentGlsSeq() + 1
  setSetting(GLS_SEQ_KEY, String(next))
  return formatGls(next)
}

/** 把计数器校准到已发放的最大号（迁移后用一次） */
export function syncGlsSeq(value?: number): number {
  const seq = Math.max(value ?? 0, maxIssuedGls())
  setSetting(GLS_SEQ_KEY, String(seq))
  return seq
}

export interface NumberRow {
  id: string
  code: string
  gls_code: string | null
  prev_code: string | null
  created_at: string
  library_state: string
}

/**
 * 重编号（一次性迁移用）：按「加入产品库的顺序」（created_at 升序）发 GLS0001…，
 * 旧编号留存到 prev_code。返回改了几条。
 */
export function renumberToGls(ids?: string[]): { updated: number; lastSeq: number } {
  const rows = db
    .prepare(
      `SELECT id, code, gls_code, prev_code, created_at, library_state
       FROM products WHERE status = 'listed'
       ORDER BY created_at ASC, code ASC`
    )
    .all() as unknown as NumberRow[]
  const target = ids?.length ? rows.filter((r) => ids.includes(r.id)) : rows
  const stmt = db.prepare(
    "UPDATE products SET code = ?, gls_code = ?, prev_code = ?, library_state = 'pre', updated_at = ? WHERE id = ?"
  )
  let seq = 0
  let updated = 0
  const now = new Date().toISOString()
  for (const r of target) {
    seq += 1
    const code = formatGls(seq)
    // 旧编号只在第一次改号时记录，避免二次迁移把 GLS 号写成 prev_code
    const prev = r.prev_code || r.code || null
    stmt.run(code, code, prev, now, r.id)
    updated += 1
  }
  syncGlsSeq(seq)
  return { updated, lastSeq: seq }
}
