/**
 * 模型调用台账。
 *
 * 为什么单独一个模块：ai.ts 是「怎么调」，这里只管「调完记一笔」。
 * 台账只回答四个问题：哪个任务、哪个模型、花了多久、成功没有（有 usage 时连 token 一起记）。
 * 写台账失败一律吞掉 —— 记日志绝不能反过来把正常生成搞挂。
 */

import { db } from '../db'

export interface AiCallLogInput {
  /** 任务名：spec-extract / listing / listing-qc / evaluate / assistant / settings-test … */
  task: string
  productId?: string | null
  model: string
  baseUrl?: string
  durationMs: number
  promptTokens?: number | null
  completionTokens?: number | null
  ok: boolean
  error?: string | null
}

export function logAiCall(input: AiCallLogInput): void {
  try {
    db.prepare(
      `INSERT INTO ai_call_logs
        (task, product_id, model, base_url, duration_ms, prompt_tokens, completion_tokens, ok, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.task || '',
      input.productId ?? null,
      input.model || '',
      // baseUrl 只存主机名：完整地址可能带 key 之类的东西，没必要落库
      hostOf(input.baseUrl),
      Math.max(0, Math.round(input.durationMs)),
      input.promptTokens ?? null,
      input.completionTokens ?? null,
      input.ok ? 1 : 0,
      input.error ? input.error.slice(0, 800) : null,
      new Date().toISOString()
    )
  } catch {
    /* 台账表不存在 / 写库抖动时忽略 */
  }
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 120)
  }
}

export interface AiCallLogRow {
  id: number
  task: string
  productId: string | null
  model: string
  baseUrl: string
  durationMs: number
  promptTokens: number | null
  completionTokens: number | null
  ok: boolean
  error: string | null
  createdAt: string
}

/** 最近 N 条调用记录（倒序），给「模型调用台账」面板用 */
export function listAiCalls(limit = 100, task?: string): AiCallLogRow[] {
  const lim = Math.max(1, Math.min(500, limit))
  const rows = (
    task
      ? db
          .prepare('SELECT * FROM ai_call_logs WHERE task = ? ORDER BY id DESC LIMIT ?')
          .all(task, lim)
      : db.prepare('SELECT * FROM ai_call_logs ORDER BY id DESC LIMIT ?').all(lim)
  ) as unknown as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    task: String(r.task ?? ''),
    productId: (r.product_id as string | null) ?? null,
    model: String(r.model ?? ''),
    baseUrl: String(r.base_url ?? ''),
    durationMs: Number(r.duration_ms ?? 0),
    promptTokens: r.prompt_tokens === null || r.prompt_tokens === undefined ? null : Number(r.prompt_tokens),
    completionTokens:
      r.completion_tokens === null || r.completion_tokens === undefined
        ? null
        : Number(r.completion_tokens),
    ok: Number(r.ok ?? 1) === 1,
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at ?? ''),
  }))
}

/** 汇总：每个任务调了几次、失败几次、平均耗时、token 合计（给批量生产中心显示成本） */
export function summarizeAiCalls(sinceHours = 24): Array<{
  task: string
  calls: number
  failed: number
  avgMs: number
  promptTokens: number
  completionTokens: number
}> {
  const since = new Date(Date.now() - Math.max(1, sinceHours) * 3600_000).toISOString()
  const rows = db
    .prepare(
      `SELECT task,
              COUNT(*) AS calls,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
              AVG(duration_ms) AS avg_ms,
              SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
              SUM(COALESCE(completion_tokens, 0)) AS completion_tokens
       FROM ai_call_logs WHERE created_at >= ? GROUP BY task ORDER BY calls DESC`
    )
    .all(since) as unknown as Array<Record<string, unknown>>
  return rows.map((r) => ({
    task: String(r.task ?? ''),
    calls: Number(r.calls ?? 0),
    failed: Number(r.failed ?? 0),
    avgMs: Math.round(Number(r.avg_ms ?? 0)),
    promptTokens: Number(r.prompt_tokens ?? 0),
    completionTokens: Number(r.completion_tokens ?? 0),
  }))
}
