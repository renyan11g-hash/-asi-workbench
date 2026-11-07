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
const PUBLIC_PATHS = ['/api/health', '/api/ping', '/api/version', '/favicon.svg', '/favicon.ico', '/robots.txt']

const sha256 = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest()

/** 定长摘要比较，避免按字符逐位比较泄露长度/前缀信息 */
const safeEqual = (a: string, b: string): boolean => {
  const da = sha256(a)
  const db = sha256(b)
  return crypto.timingSafeEqual(da, db)
}

/**
 * 「登录一次管一天」用的会话 cookie。
 *
 * 为什么不用 Basic 硬扛：Basic 凭据只活在浏览器进程里，关掉浏览器/隔一段时间
 * 就会重新弹系统登录框，一天要输好几次。这里在 Basic 验证通过后额外种一个
 * HttpOnly cookie（凭据的 HMAC，不含密码本身），有效期 1 天；
 * 之后带着这个 cookie 的请求直接放行，不再弹框。
 *
 * token 由密码派生，所以改密码 = 所有旧 cookie 自动失效；服务重启也不影响。
 */
const SESSION_COOKIE = 'asi_auth'
const SESSION_MAX_AGE_SEC = 24 * 60 * 60

function sessionToken(): string {
  return crypto
    .createHmac('sha256', env.BASIC_AUTH_PASS)
    .update('asi-workbench-session-v1')
    .digest('hex')
}

function readCookie(req: Parameters<RequestHandler>[0], name: string): string {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return ''
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

  // ① 一天内登录过：cookie 有效就直接放行，不再弹系统登录框
  const cookie = readCookie(req, SESSION_COOKIE)
  if (cookie && safeEqual(cookie, sessionToken())) return next()

  // ② 带着 Basic 凭据：验证通过后顺手种 cookie，之后一天内都不用再输
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
        const secure = req.secure || req.get('x-forwarded-proto') === 'https'
        res.cookie(SESSION_COOKIE, sessionToken(), {
          httpOnly: true,
          sameSite: 'lax',
          secure,
          path: '/',
          maxAge: SESSION_MAX_AGE_SEC * 1000,
        })
        return next()
      }
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="ASI Workbench", charset="UTF-8"')
  res.setHeader('Cache-Control', 'no-store')
  return res.status(401).type('text/plain; charset=utf-8').send('需要登录才能访问 ASI 选品工作台')
}

/** 主动退出：清掉会话 cookie（页面里点「退出登录」用） */
export const logoutHandler: RequestHandler = (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' })
  res.json({ ok: true, message: '已退出登录，下次访问需要重新输入密码' })
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
