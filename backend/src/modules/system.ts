import { Router, Request, Response } from 'express'
import { db } from '../db'
import { probeWithDiag } from '../services/market-probe'
import { logoutHandler } from '../middleware/auth'

export const systemRouter: Router = Router()

// ============================================
// System & Health Routes
// ============================================

/**
 * API root - welcome message
 */
systemRouter.get('/', async (_req: Request, res: Response) => {
  res.json({
    message: 'Welcome to the API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    documentation: '/api/docs', // TODO: Add API documentation
  })
})

/**
 * 最近的服务器异常（500 现场）。
 * 线上跑在 Render，日志拿不到，所以异常直接落库，这里查得到真正原因。
 */
systemRouter.get('/health/errors', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20))
  try {
    const rows = db
      .prepare('SELECT id, method, path, message, stack, created_at FROM server_errors ORDER BY id DESC LIMIT ?')
      .all(limit)
    res.json({ ok: true, errors: rows })
  } catch (e) {
    res.json({ ok: false, errors: [], message: (e as Error)?.message ?? String(e) })
  }
})

/** 退出登录：清掉「一天免登录」的 cookie */
systemRouter.post('/logout', logoutHandler)

/**
 * Basic health check - always returns OK
 */
systemRouter.get('/health', async (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
})

/**
 * Readiness check —— 真连一次数据库。
 *
 * 这个接口在 PUBLIC_PATHS 的 `/api/health` 前缀下，不需要登录就能访问，
 * 所以部署后可以从外面直接确认 Turso 连接是否正常（token 过期/写错会在这里暴露）。
 */
systemRouter.get('/health/ready', async (_req: Request, res: Response) => {
  let database = 'ok'
  try {
    db.prepare('SELECT 1 AS ok').get()
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    database = `error: ${msg.slice(0, 200)}`
  }
  res.json({
    status: database === 'ok' ? 'ready' : 'degraded',
    timestamp: new Date().toISOString(),
    dbMode: /^libsql:\/\//.test(process.env.LIBSQL_URL || '') ? 'turso' : 'local',
    hasAuthToken: Boolean(process.env.LIBSQL_AUTH_TOKEN),
    checks: { database },
  })
})

/**
 * 海外市场探针自检（免登录，在 /api/health 前缀下）
 * 用法：GET /api/health/market-probe?q=tote%20bag&core=toiletry,bag&pt=Hanging%20Travel%20Toiletry%20Bag
 * core/pt 可选：用来验证"相关性过滤"有没有按预期筛掉泛匹配噪声。
 * 返回每一步抓到多少字节、解析出几条、失败原因——用于排查 Render 上为什么取不到同款数据。
 */
systemRouter.get('/health/market-probe', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2)
  const core = String(req.query.core ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const productType = String(req.query.pt ?? '').trim()
  const diag = await probeWithDiag(q, 9000, { coreKeywords: core, productType })
  const esp = diag.esp?.snapshot ?? null
  res.json({
    ok: Boolean(diag.snapshot),
    error: diag.error ?? null,
    queries: diag.queries,
    matchTokens: diag.snapshot?.matchTokens ?? [],
    perQuery: diag.perQuery,
    price: diag.snapshot?.price ?? null,
    total: diag.snapshot?.total ?? 0,
    matched: diag.snapshot?.matched ?? 0,
    densityCount: diag.snapshot?.densityCount ?? 0,
    relevanceNote: diag.snapshot?.relevanceNote ?? null,
    scores: diag.snapshot
      ? {
          density: diag.snapshot.densityScore,
          spread: diag.snapshot.spreadScore,
          diff: diag.snapshot.diffEstimate,
          competition: diag.snapshot.competitionEstimate,
        }
      : null,
    sample: diag.snapshot?.items?.slice(0, 3) ?? [],
    /** ASI / ESP 全供应商目录那一路（差异化的主依据） */
    esp: {
      ok: Boolean(esp),
      error: diag.esp?.error ?? null,
      total: esp?.total ?? 0,
      matchedSample: esp?.matchedSample ?? 0,
      sampleSize: esp?.sampleSize ?? 0,
      fallback: esp?.fallback ?? null,
      densityScore: esp?.densityScore ?? null,
      categories: esp?.categories ?? [],
      price: esp?.price ?? null,
      relevanceNote: esp?.relevanceNote ?? null,
      perQuery: diag.esp?.perQuery ?? [],
      sample: esp?.items?.slice(0, 3) ?? [],
    },
  })
})

/**
 * Liveness check - verifies service is alive
 */
systemRouter.get('/health/live', async (_req: Request, res: Response) => {
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  })
})

/**
 * API version information
 */
systemRouter.get('/version', async (_req: Request, res: Response) => {
  res.json({
    version: '1.0.0',
    apiVersion: 'v1',
    // 部署核对用：Render 会把本次构建的 commit 注入环境变量
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '',
    branch: process.env.RENDER_GIT_BRANCH || '',
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    nodeVersion: process.version,
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  })
})

/**
 * Simple ping endpoint
 */
systemRouter.get('/ping', async (_req: Request, res: Response) => {
  res.json({
    message: 'pong',
    timestamp: new Date().toISOString(),
  })
})

/**
 * System status with uptime and memory info
 */
systemRouter.get('/status', async (_req: Request, res: Response) => {
  const memoryUsage = process.memoryUsage()

  res.json({
    status: 'operational',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: {
      rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(memoryUsage.external / 1024 / 1024)}MB`,
    },
    process: {
      pid: process.pid,
      platform: process.platform,
      nodeVersion: process.version,
    },
  })
})
