import { RequestHandler } from 'express'
import crypto from 'crypto'
import { env } from '../config/env'

/**
 * 访问保护（HTTP Basic Auth）
 *
 * 设计要点：
 * - 只在同时配置了 BASIC_AUTH_USER 与 BASIC_AUTH_PASS 时启用；未配置 = 完全关闭，
 *   避免本地开发被打扰，也避免"部署了但忘了配环境变量"把用户自己锁在门外。
 * - 浏览器首次访问弹出系统登录框，成功后凭据由浏览器缓存，页面里所有 XHR / 图片请求
 *   会自动带上 Authorization 头，前端代码零改动。
 * - /api/health 必须放行：Render 的健康检查拿不到凭据，挡住会导致服务被判定为不健康。
 */

// 无需鉴权的路径（前缀匹配）
const PUBLIC_PATHS = ['/api/health', '/api/ping', '/favicon.svg', '/favicon.ico', '/robots.txt']

const sha256 = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest()

/** 定长摘要比较，避免按字符逐位比较泄露长度/前缀信息 */
const safeEqual = (a: string, b: string): boolean => {
  const da = sha256(a)
  const db = sha256(b)
  return crypto.timingSafeEqual(da, db)
}

export const basicAuth: RequestHandler = (req, res, next) => {
  // 未配置凭据 → 不启用（开发环境 / 尚未配置的部署）
  if (!env.BASIC_AUTH_USER || !env.BASIC_AUTH_PASS) return next()

  // CORS 预检不带凭据，必须放行，否则浏览器连请求都发不出来
  if (req.method === 'OPTIONS') return next()

  const path = req.path
  if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return next()

  // 机器调用：GitHub Actions 等外部任务用 x-sync-token 代替 Basic（密码不适合放进 workflow 日志）
  if (env.SYNC_TOKEN) {
    const token = req.get('x-sync-token') ?? ''
    if (token && safeEqual(token, env.SYNC_TOKEN)) return next()
  }

  const header = req.headers.authorization ?? ''
  if (header.startsWith('Basic ')) {
    let decoded = ''
    try {
      decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
    } catch {
      decoded = ''
    }
    const sep = decoded.indexOf(':')
    if (sep > 0) {
      const user = decoded.slice(0, sep)
      const pass = decoded.slice(sep + 1)
      if (safeEqual(user, env.BASIC_AUTH_USER) && safeEqual(pass, env.BASIC_AUTH_PASS)) {
        return next()
      }
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="ASI Workbench", charset="UTF-8"')
  res.setHeader('Cache-Control', 'no-store')
  return res.status(401).type('text/plain; charset=utf-8').send('需要登录才能访问 ASI 选品工作台')
}

/**
 * 同源守卫（CSRF 防护）
 *
 * 浏览器会把已缓存的 Basic 凭据自动附带到跨站请求上，所以仅靠 Basic Auth
 * 挡不住"别的网站替你的浏览器发 POST"。这里对写操作要求 Origin/Host 一致。
 * 只在生产环境生效，避免打断本地前端（5173）直连后端（3000）的开发方式。
 */
export const sameOriginGuard: RequestHandler = (req, res, next) => {
  if (req.method === 'OPTIONS') return next()
  if (env.NODE_ENV !== 'production') return next() // 本地前端(5173)直连后端(3000)的场景放行

  if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: '拒绝跨站请求' })
  }

  const origin = req.get('origin')
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      return res.status(403).json({ error: '来源不合法' })
    }
    if (originHost !== (req.get('host') ?? '')) {
      return res.status(403).json({ error: '来源不被允许' })
    }
  }

  return next()
}
