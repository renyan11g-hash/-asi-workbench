import { Router, Request, Response } from 'express'
import { db } from '../db'
import { probeWithDiag } from '../services/market-probe'

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
 * 用法：GET /api/health/market-probe?q=tote%20bag,insulated%20tumbler
 * 返回每一步抓到多少字节、解析出几条、失败原因——用于排查 Render 上为什么取不到同款数据。
 */
systemRouter.get('/health/market-probe', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2)
  const diag = await probeWithDiag(q)
  res.json({
    ok: Boolean(diag.snapshot),
    error: diag.error ?? null,
    queries: diag.queries,
    perQuery: diag.perQuery,
    price: diag.snapshot?.price ?? null,
    total: diag.snapshot?.total ?? 0,
    sample: diag.snapshot?.items?.slice(0, 3) ?? [],
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
