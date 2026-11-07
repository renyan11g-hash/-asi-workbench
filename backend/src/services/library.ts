/**
 * 库与编号（2026-11-07 需求）。
 *
 * 三个库的关系：
 *   流水线/评估库  —— 还没定下来的产品（status='sourced' 或评估中）
 *   预产品库       —— 审核通过、发了 GLS 号的产品（status='listed' 且 library_state='pre'）
 *   RPA 档案库     —— 从预产品库里挑出来、人工重新赋号的产品（library_state='rpa'）
 *
 * 规矩：GLS 号发出去就不再复用；进 RPA 档案库只换号（code），gls_code 留着可追溯。
 */

import { db } from '../db'
import { formatGls, nextGlsCode } from './numbering'

export interface LibraryRow {
  id: string
  code: string
  glsCode: string | null
  prevCode: string | null
  libraryState: string
  status: string
  title: string
  sourceUrl: string
  score: number | null
  verdict: string | null
  evalReview: string | null
  reviewState: string | null
  hasListing: boolean
  updatedAt: string
  rpaArchivedAt: string | null
}

interface RawRow {
  id: string
  code: string
  gls_code: string | null
  prev_code: string | null
  library_state: string | null
  status: string
  source_title: string
  source_url: string
  score: number | null
  verdict: string | null
  eval_review: string | null
  review_state: string | null
  has_listing: number
  updated_at: string
  rpa_archived_at: string | null
}

function toRow(r: RawRow): LibraryRow {
  return {
    id: r.id,
    code: r.code || '',
    glsCode: r.gls_code,
    prevCode: r.prev_code,
    libraryState: r.library_state ?? 'pipeline',
    status: r.status,
    title: r.source_title || '',
    sourceUrl: r.source_url || '',
    score: r.score ?? null,
    verdict: r.verdict ?? null,
    evalReview: r.eval_review ?? null,
    reviewState: r.review_state ?? null,
    hasListing: Boolean(r.has_listing),
    updatedAt: r.updated_at,
    rpaArchivedAt: r.rpa_archived_at,
  }
}

const BASE_SELECT = `SELECT id, code, gls_code, prev_code, library_state, status, source_title, source_url,
       score, verdict, eval_review, review_state, rpa_archived_at, updated_at,
       CASE WHEN listing IS NOT NULL THEN 1 ELSE 0 END AS has_listing
  FROM products`

/** 预产品库：已审核通过、已发 GLS 号的产品（RPA 档案库里的不算） */
export function listPreProducts(): LibraryRow[] {
  const rows = db
    .prepare(
      `${BASE_SELECT} WHERE status = 'listed' AND COALESCE(library_state,'pre') != 'rpa'
       ORDER BY code ASC`
    )
    .all() as unknown as RawRow[]
  return rows.map(toRow)
}

/** RPA 档案库：从预产品库改过号的产品 */
export function listRpaArchive(): LibraryRow[] {
  const rows = db
    .prepare(`${BASE_SELECT} WHERE library_state = 'rpa' ORDER BY rpa_archived_at DESC, code ASC`)
    .all() as unknown as RawRow[]
  return rows.map(toRow)
}

/** 产品第一次进预产品库时发 GLS 号；已经有号就只把库标记改成 pre */
export function enterPreLibrary(productId: string): { code: string; assigned: boolean } | null {
  const row = db
    .prepare('SELECT id, code, gls_code, prev_code, library_state, status FROM products WHERE id = ?')
    .get(productId) as
    | { id: string; code: string; gls_code: string | null; prev_code: string | null; library_state: string | null; status: string }
    | undefined
  if (!row) return null
  const now = new Date().toISOString()
  if (row.gls_code) {
    db.prepare(
      "UPDATE products SET library_state='pre', status='listed', updated_at=? WHERE id=?"
    ).run(now, productId)
    return { code: row.code || row.gls_code, assigned: false }
  }
  const code = nextGlsCode()
  db.prepare(
    "UPDATE products SET code=?, gls_code=?, prev_code=?, library_state='pre', status='listed', updated_at=? WHERE id=?"
  ).run(code, code, row.code || null, now, productId)
  return { code, assigned: true }
}

/**
 * 从预产品库移进 RPA 档案库：人工给新编号，覆盖当前编号；旧编号（GLS）留在 prev_code。
 * 新编号必须唯一，且不能撞现有任何编号。
 */
export function archiveToRpa(
  entries: Array<{ productId: string; code: string }>
): { moved: number; failed: Array<{ productId: string; error: string }> } {
  const failed: Array<{ productId: string; error: string }> = []
  let moved = 0
  const now = new Date().toISOString()
  for (const e of entries) {
    const code = (e.code || '').trim()
    if (!code) {
      failed.push({ productId: e.productId, error: '新编号是空的' })
      continue
    }
    const row = db
      .prepare("SELECT id, code, gls_code, library_state, status FROM products WHERE id = ?")
      .get(e.productId) as
      | { id: string; code: string; gls_code: string | null; library_state: string | null; status: string }
      | undefined
    if (!row) {
      failed.push({ productId: e.productId, error: '产品不存在' })
      continue
    }
    if (row.library_state === 'rpa') {
      failed.push({ productId: e.productId, error: '这条已经在 RPA 档案库了' })
      continue
    }
    const dup = db.prepare('SELECT id FROM products WHERE code = ? AND id != ?').get(code, e.productId) as
      | { id: string }
      | undefined
    if (dup) {
      failed.push({ productId: e.productId, error: `编号 ${code} 已被别的产品占用` })
      continue
    }
    // 进 RPA 档案库：换号后 GLS 号不再发给别人（计数器只增不减），旧号留在 prev_code
    db.prepare(
      "UPDATE products SET code=?, prev_code=?, library_state='rpa', rpa_archived_at=?, updated_at=? WHERE id=?"
    ).run(code, row.gls_code || row.code || null, now, now, e.productId)
    moved += 1
  }
  return { moved, failed }
}

/** 评估库列表（产品维度）：不看草稿，直接看「哪些产品评估过、审核结果如何」 */
export function listEvaluations(): Array<
  LibraryRow & {
    evalSummary: string
    evalScore: number | null
    evalVerdict: string | null
    evalReviewedAt: string | null
    draftId: string | null
    /** 优缺点与改善建议：评估库展开时直接看，不用再点进产品 */
    evalPros: string[]
    evalCons: string[]
    evalSuggestions: string[]
    evalBuyers: string[]
  }
> {
  const rows = db
    .prepare(
      `SELECT id, code, gls_code, prev_code, library_state, status, source_title, source_url,
              score, verdict, eval_review, review_state, rpa_archived_at, updated_at,
              evaluation, eval_reviewed_at, draft_id,
              CASE WHEN listing IS NOT NULL THEN 1 ELSE 0 END AS has_listing
       FROM products WHERE evaluation IS NOT NULL AND status != 'trashed'
       ORDER BY updated_at DESC`
    )
    .all() as unknown as Array<
    RawRow & { evaluation: string; eval_reviewed_at: string | null; draft_id: string | null }
  >
  return rows.map((r) => {
    let summary = ''
    let pros: string[] = []
    let cons: string[] = []
    let suggestions: string[] = []
    let buyers: string[] = []
    try {
      const e = JSON.parse(r.evaluation) as {
        summary?: string
        pros?: string[]
        cons?: string[]
        suggestions?: string[]
        buyers?: string[]
      }
      summary = String(e.summary ?? '').slice(0, 300)
      pros = (e.pros ?? []).map(String).slice(0, 8)
      cons = (e.cons ?? []).map(String).slice(0, 8)
      suggestions = (e.suggestions ?? []).map(String).slice(0, 8)
      buyers = (e.buyers ?? []).map(String).slice(0, 8)
    } catch {
      summary = ''
    }
    return {
      ...toRow(r),
      // 已经在预产品库里的产品，本来就是「评估通过才能上架」，
      // 老数据没有 eval_review 字段，这里按 listed 反推成 approved，避免评估库把历史产品全显示成「未审核」
      evalReview: r.eval_review ?? (r.status === 'listed' ? 'approved' : null),
      evalSummary: summary,
      evalScore: r.score ?? null,
      evalVerdict: r.verdict ?? null,
      evalReviewedAt: r.eval_reviewed_at ?? null,
      draftId: r.draft_id ?? null,
      evalPros: pros,
      evalCons: cons,
      evalSuggestions: suggestions,
      evalBuyers: buyers,
    }
  })
}

/** 编号预览：迁移前给用户看一眼「会变成什么样」 */
export function previewGlSNumbering(): Array<{ id: string; title: string; oldCode: string; newCode: string; createdAt: string }> {
  const rows = db
    .prepare(
      "SELECT id, code, source_title, created_at FROM products WHERE status = 'listed' ORDER BY created_at ASC, code ASC"
    )
    .all() as unknown as Array<{ id: string; code: string; source_title: string; created_at: string }>
  return rows.map((r, i) => ({
    id: r.id,
    title: r.source_title || '',
    oldCode: r.code || '',
    newCode: formatGls(i + 1),
    createdAt: r.created_at,
  }))
}
