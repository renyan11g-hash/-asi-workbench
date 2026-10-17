import fs from 'fs'
import path from 'path'
import express, { Application } from 'express'
import cors from 'cors'
import compression from 'compression'
import 'express-async-errors'
import { env } from './config/env'
import { errorHandler } from './middleware/errorHandler'
import { httpLogger } from './middleware/logger'
import { systemRouter } from './modules/system'
import { productsRouter } from './modules/products'
import { settingsRouter } from './modules/settings'
import { draftsRouter } from './modules/drafts'

export const createApp = (): Application => {
  const app = express()

  // HTTP request logging
  app.use(httpLogger)

  app.use(
    cors({
      origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN,
      credentials: env.CORS_ORIGIN !== '*',
    })
  )

  // Body parsing and compression
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  app.use(compression())

  // API routes - System & Health
  app.use(env.API_PREFIX, systemRouter)

  app.use(`${env.API_PREFIX}/products`, productsRouter)
  app.use(`${env.API_PREFIX}/settings`, settingsRouter)
  app.use(`${env.API_PREFIX}/drafts`, draftsRouter)

  // 生产环境：托管前端构建产物（单端口部署）
  const staticDir = resolveStaticDir()
  if (staticDir) {
    // 静态资源长缓存（文件名带 hash，内容变更时换新文件名）
    app.use(express.static(staticDir, { index: false, maxAge: '1d', immutable: true }))
    // SPA fallback：HTML 强不缓存（保证每次拿到最新版本），同时注入 loading 占位
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next()
      // 带扩展名的请求（旧 JS/CSS 已随重新部署消失）必须 404：
      // 若返回 HTML 会被浏览器当作 JS 执行，MIME 检查失败 → 整页白屏
      if (path.extname(req.path)) return res.status(404).send('Not found')
      const fp = path.join(staticDir, 'index.html')
      fs.readFile(fp, 'utf8', (err, html) => {
        if (err) return next()
        // 公网 gateway 会在响应里追加一个同步 <script src="beacon.cdn.qq.com"> 阻塞解析器。
        // 我们用一段 inline 脚本：把任何 beacon 同步 script 标记为 async，并设 2s 超时；
        // 同时如果 8 秒后 React 还没渲染（说明 JS 卡住），提示用户强制刷新。
        const boot = `<script>(function(){try{var o=new MutationObserver(function(m){m.forEach(function(r){r.addedNodes.forEach(function(n){if(n&&n.tagName==='SCRIPT'&&n.src&&/beacon\\.cdn\\.qq\\.com/.test(n.src)){n.async=true;n.setAttribute('data-fixed','1');}});});});o.observe(document.documentElement,{childList:true,subtree:true});setTimeout(function(){var root=document.getElementById('root');if(root&&root.getAttribute('data-booted')!=='1'){root.setAttribute('data-stuck','1');var old=document.getElementById('__load__');if(old)old.innerHTML='<p style=\"margin:8px 0 4px;font-size:13px;color:#ef4444\">页面加载超时（JS 未启动）</p><p style=\"margin:0 0 12px;font-size:11px;color:#94a3b8\">可能是网络被墙，请按 Ctrl+Shift+R 强刷</p><button onclick=\"location.reload()\" style=\"padding:6px 16px;border:1px solid #cbd5e1;border-radius:4px;background:white;cursor:pointer;font-size:12px\">强制刷新</button>';}}},8000);}catch(e){}})();</script>`
        const loadingDiv =
          '<div id="__load__" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#64748b"><div style="margin-bottom:12px">正在加载 ASI 选品工作台…</div><div style="width:240px;height:3px;background:#e2e8f0;border-radius:2px;overflow:hidden"><div style="width:40%;height:100%;background:#3b82f6;animation:slide 1.2s infinite"></div></div><style>@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}</style></div>'
        const withFallback = html.replace(
          /<div id="root"><\/div>/i,
          `<div id="root" data-booted="0">${loadingDiv}</div>${boot}<script>(function(){var mo=new MutationObserver(function(){if(document.getElementById('root')&&!document.getElementById('__load__')){var r=document.getElementById('root');if(r)r.setAttribute('data-booted','1');}});mo.observe(document.getElementById('root'),{childList:true,subtree:true});})();</script>`
        )
        res.setHeader('Content-Type', 'text/html; charset=UTF-8')
        res.setHeader('Cache-Control', 'no-store, must-revalidate')
        // 清除浏览器缓存的 HTTP/3(QUIC) 协议偏好，规避部分代理网络下 QUIC 挂起导致“一直在加载”
        res.setHeader('Alt-Svc', 'clear')
        res.setHeader('X-Build', 'asi-v5')
        res.send(withFallback)
      })
    })
  }

  // Error handling
  app.use(errorHandler)

  return app
}

/** 定位前端 dist 目录，找不到则不托管（纯 API 模式） */
function resolveStaticDir(): string | null {
  const candidates = [
    process.env.STATIC_DIR,
    path.join(process.cwd(), 'public'),
    path.join(process.cwd(), 'dist', 'public'),
    path.join(process.cwd(), '../frontend/dist'),
    path.join(process.cwd(), '../../frontend/dist'),
    '/opt/render/project/src/frontend/dist',
  ].filter(Boolean) as string[]

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir
    } catch {
      /* ignore */
    }
  }
  return null
}
