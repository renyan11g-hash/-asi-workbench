#!/usr/bin/env node
/**
 * 本机选品（带真实浏览器登录态，绕开 1688 反爬）
 *
 * 用法：
 *   node scripts/local-sourcing.mjs --login      # 第一次：弹出浏览器，扫码登录 1688，登录后自动记住
 *   node scripts/local-sourcing.mjs              # 日常：用记忆的登录态跑一次
 *   node scripts/local-sourcing.mjs --limit 8
 *   node scripts/local-sourcing.mjs --keywords "定制保温杯,定制托特包"
 *
 * 环境变量：
 *   SITE_URL       https://asi-workbench.onrender.com
 *   SYNC_TOKEN     Render 里配的同一个值
 *   PLAYWRIGHT_BASE 装着 playwright 的目录（默认取本文件所在仓库的上一级 asi-local-runner）
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const PW_BASE = process.env.PLAYWRIGHT_BASE || path.resolve(REPO_ROOT, '..', 'asi-local-runner')
const requireFromRunner = createRequire(path.join(PW_BASE, 'noop.js'))
const { chromium } = requireFromRunner('playwright')

const SITE = (process.env.SITE_URL || 'https://asi-workbench.onrender.com').replace(/\/$/, '')
const TOKEN = process.env.SYNC_TOKEN || ''
const PROFILE = process.env.PROFILE_DIR || path.join(PW_BASE, '.pw-profile')

const argv = process.argv.slice(2)
const arg = (name, def = '') => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true') : def
}
const limit = Number(arg('limit', process.env.LIMIT || 5))
const kwArg = arg('keywords', process.env.KEYWORDS || '')
const isLogin = argv.includes('--login')
const isUnlock = argv.includes('--unlock')

const POOL = [
  '定制帆布托特包', '定制不锈钢保温杯', '定制办公笔记本', '定制棒球帽',
  '定制运动毛巾', '定制鼠标垫', '定制折叠购物袋', '定制硅胶杯垫',
  '定制行李牌', '定制颈枕', '定制车载手机支架', '定制瑜伽垫',
]
const CROSS_BORDER = /跨境|外贸|亚马逊|amazon|速卖通|temu|shein|独立站|一件代发|出口|海外/i
const CUSTOM = /定制|订制|LOGO|logo|印刷|丝印|烫金|烫印|刺绣|绣花|贴牌|印图|激光|刻字|可加|打样/
const BRAND = /品牌|商标|专利|迪士尼|漫威|NBA|卡通|联名/

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

async function get(url, timeout = 20000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    })
    return r.ok ? await r.text() : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

const clean = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

function parse360(html) {
  const out = []
  const seen = new Set()
  for (const block of html.split(/<li[^>]*class="res-list[^"]*"/).slice(1)) {
    const m = block.match(/data-mdurl="(https:\/\/detail\.1688\.com\/offer\/(\d{6,})\.html)"/)
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    const start = block.indexOf('data-mdurl')
    const around = block.slice(Math.max(0, start - 2000), start + 3000)
    let title = clean(around.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '')
    if (!title) title = clean(block).slice(0, 60)
    const desc = clean(block.match(/class="res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '')
    const price = desc.match(/[¥￥]\s*(\d{1,5}(?:\.\d{1,2})?)/)?.[1]
    out.push({ url: m[1], offerId: m[2], title, desc, priceCny: price ? Number(price) : null })
  }
  return out
}

function parseSogou(html) {
  const ids = new Set()
  for (const m of html.matchAll(/offer\/(\d{6,})\.html/g)) ids.add(m[1])
  return [...ids].map((id) => ({ url: `https://detail.1688.com/offer/${id}.html`, offerId: id, title: '', desc: '', priceCny: null }))
}

/** 用登录态浏览器打开商品页，抽取标题 / 价格 / 主图 / 规格文本 */
async function scrapeOffer(ctx, url) {
  const page = await ctx.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(2500 + Math.random() * 1500)

    const t = await page.title()
    if (/captcha|验证|拦截/i.test(t)) return { blocked: true }

    const data = await page.evaluate(() => {
      const txt = (sel) => document.querySelector(sel)?.innerText?.trim() || ''
      const title =
        txt('h1') ||
        txt('.title-text') ||
        txt('[class*="title"]') ||
        document.title.replace(/[-–—|｜]\s*(阿里巴巴|1688).*$/i, '').trim()
      const bodyText = document.body.innerText || ''
      const priceM = bodyText.match(/[¥￥]\s*(\d{1,5}(?:\.\d{1,2})?)/)
      const imgs = [...document.querySelectorAll('img')]
        .map((i) => i.src || '')
        .filter((s) => /alicdn\.com/.test(s) && /\.(jpg|png|webp)/i.test(s))
      const sizeM = bodyText.match(/(尺寸|规格)[:：\s]*([^\n]{2,60})/)
      return {
        title,
        price: priceM ? Number(priceM[1]) : null,
        images: [...new Set(imgs)].slice(0, 3),
        spec: sizeM ? sizeM[2] : '',
        snippet: bodyText.replace(/\s+/g, ' ').slice(0, 800),
      }
    })
    if (!data.title) return { blocked: true }
    return data
  } catch (e) {
    return { error: e.message }
  } finally {
    await page.close().catch(() => {})
  }
}

async function api(pathname, body) {
  const r = await fetch(SITE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': TOKEN },
    body: JSON.stringify(body ?? {}),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text.slice(0, 200) }
  return { status: r.status, body: json }
}

async function main() {
  if (!TOKEN && !isLogin) throw new Error('缺少 SYNC_TOKEN 环境变量')

  fs.mkdirSync(PROFILE, { recursive: true })

  // ---------- 解锁模式：人工过一次滑块，给这个 profile 刷掉风控标记 ----------
  if (isUnlock) {
    const probe = argv[arg('url', '')] || 'https://detail.1688.com/offer/525180170095.html'
    log('打开商品页，如果出现滑块验证，请手动拖动通过…', probe)
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      viewport: null,
      args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    })
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    const page = ctx.pages()[0] || (await ctx.newPage())
    await page.goto(probe, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})

    let ok = false
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      const title = await page.title().catch(() => '')
      const looksBlocked = /captcha|验证|拦截/i.test(title)
      if (!looksBlocked) {
        const h1 = await page.evaluate(() => document.querySelector('h1')?.innerText || '').catch(() => '')
        if (h1) { ok = true; break }
      }
      if (i === 11) log('已等 1 分钟…拖动滑块后页面会出现商品标题，我会自动识别')
    }
    log(ok ? '✅ 验证通过，风控标记已刷新（以后跑脚本会用这个状态）' : '⚠️ 仍未通过，可再执行一次 --unlock')
    await ctx.close()
    return
  }

  // ---------- 登录模式 ----------
  if (isLogin) {
    log('打开浏览器，请用 1688 App 扫码登录…')
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      viewport: null,
      args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    })
    const page = ctx.pages()[0] || (await ctx.newPage())
    await page.goto('https://www.1688.com/', { waitUntil: 'domcontentloaded' }).catch(() => {})

    const check = async () => {
      const p = await ctx.newPage()
      try {
        await p.goto('https://work.1688.com/', { waitUntil: 'domcontentloaded', timeout: 25000 })
        await p.waitForTimeout(1200)
        const url = p.url()
        const title = await p.title().catch(() => '')
        const logged = !/login|signin/i.test(url) && !/登录/i.test(title)
        return logged
      } catch {
        return false
      } finally {
        await p.close().catch(() => {})
      }
    }

    log('浏览器已打开（窗口标题含 1688）。请扫码；脚本每 15 秒检查一次，最多等 15 分钟')
    let ok = false
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 15000))
      ok = await check()
      if (ok) break
      if (i % 4 === 3) log(`仍在等待扫码…（已等 ${Math.round(((i + 1) * 15) / 60)} 分钟）`)
    }
    log(ok ? '✅ 登录成功，登录态已保存，可以关掉浏览器了' : '⚠️ 15 分钟内没检测到登录；请重新执行 --login')
    await ctx.close()
    return
  }

  // ---------- 日常模式 ----------
  const day = Math.floor(Date.now() / 86400000)
  const fromEnv = kwArg.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)
  const start = day % POOL.length
  const keywords = fromEnv.length ? fromEnv.slice(0, 4) : [0, 1, 2, 3].map((i) => POOL[(start + i) % POOL.length])
  log('搜索词:', keywords.join('、'))

  const hits = new Map()
  for (const kw of keywords) {
    const [so, sg] = await Promise.all([
      get(`https://www.so.com/s?q=${encodeURIComponent(`site:detail.1688.com ${kw}`)}`),
      get(`https://www.sogou.com/web?query=${encodeURIComponent(`site:detail.1688.com ${kw}`)}`),
    ])
    for (const h of so ? parse360(so) : []) if (!hits.has(h.offerId)) hits.set(h.offerId, { ...h, keyword: kw })
    for (const h of sg ? parseSogou(sg) : []) if (!hits.has(h.offerId)) hits.set(h.offerId, { ...h, keyword: kw })
    log(`「${kw}」累计 ${hits.size} 条`)
    await new Promise((r) => setTimeout(r, 1200))
  }
  if (!hits.size) { log('没搜到链接，退出'); return }

  const cands = [...hits.values()]
    .filter((h) => h.priceCny == null || (h.priceCny >= 0.5 && h.priceCny <= 150))
    .sort((a, b) => Number(CROSS_BORDER.test(`${b.title} ${b.desc}`)) - Number(CROSS_BORDER.test(`${a.title} ${a.desc}`)))
  log('粗筛后', cands.length, '条')

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const items = []
  let blocked = 0
  for (const c of cands) {
    if (items.length >= limit) break
    const d = await scrapeOffer(ctx, c.url)
    if (d?.blocked) { blocked++; log('被拦', c.offerId); await new Promise((r) => setTimeout(r, 4000)); continue }
    if (d?.error || !d) { log('抓取异常', c.offerId, d?.error || ''); continue }
    const title = d.title || c.title
    const text = `${title} ${d.snippet}`
    if (!CUSTOM.test(text) && BRAND.test(title)) { log('疑似品牌且不支持定制，跳过'); continue }
    const signals = []
    if (CROSS_BORDER.test(text)) signals.push('跨境/外贸信号')
    if (CUSTOM.test(text)) signals.push('支持定制')
    if (d.price) signals.push(`1688 报价 ¥${d.price}`)
    signals.push('浏览器登录态抓取')
    items.push({
      source: {
        sourceUrl: c.url,
        sourceTitle: title,
        description: d.spec ? `规格：${d.spec}。${d.snippet}` : d.snippet,
        sourceKeywords: [],
        amazonTitle: '',
        priceCny: d.price ?? c.priceCny ?? undefined,
        images: d.images ?? [],
        category: '',
        notes: '',
        supplier: '',
        materialCn: '',
        colorsCn: '',
        sizeCn: d.spec || '',
      },
      selectionReason: `搜索词「${c.keyword}」命中；${signals.join('、')}`,
    })
    log('候选:', title.slice(0, 30))
  }
  await ctx.close()
  log(`抓到 ${items.length} 条（被拦 ${blocked}）`)
  if (!items.length) return

  const imp = await api('/api/products/import', { items })
  log('导入', imp.status, JSON.stringify(imp.body).slice(0, 160))
  if (imp.status === 401) throw new Error('导入被拒（401）：Render 的 SYNC_TOKEN 与本机不一致')
  const created = imp.body.created || []
  for (const c of created) {
    await api(`/api/products/${c.id}/evaluate`)
    await api(`/api/products/${c.id}/rescore`)
    log('已评估', c.title.slice(0, 24))
    await new Promise((r) => setTimeout(r, 1200))
  }
  log(`完成：新增 ${created.length} 条`)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
