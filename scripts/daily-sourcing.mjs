#!/usr/bin/env node
/**
 * 每日自动选品（在 GitHub Actions 或任意机器上跑，不占 Render 实例）
 *
 * 流程：搜 1688（360 + 搜狗）→ 粗筛 → 抓详情 → POST 到站点 /api/products/import
 *       → 逐条调 /:id/evaluate（AI）→ /:id/rescore（v2 评分）
 *
 * 需要的环境变量：
 *   SITE_URL      https://asi-workbench.onrender.com
 *   SYNC_TOKEN    Render 环境变量里配的同一个值
 *   LIMIT         本次最多导入几条（默认 5）
 *   KEYWORDS      可选，逗号分隔的中文搜索词；留空用内置池轮换
 */

const SITE = (process.env.SITE_URL || 'https://asi-workbench.onrender.com').replace(/\/$/, '')
const TOKEN = process.env.SYNC_TOKEN || ''
const LIMIT = Number(process.env.LIMIT || 5)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

const POOL = [
  '定制帆布托特包', '定制不锈钢保温杯', '定制办公笔记本', '定制棒球帽',
  '定制运动毛巾', '定制鼠标垫', '定制折叠购物袋', '定制硅胶杯垫',
  '定制行李牌', '定制颈枕', '定制帆布袋 手提', '定制车载手机支架',
  '定制瑜伽垫', '定制野餐垫', '定制笔筒', '定制登山扣水壶',
]
const CROSS_BORDER = /跨境|外贸|亚马逊|amazon|速卖通|temu|shein|独立站|一件代发|出口|海外/i
const CUSTOM = /定制|订制|LOGO|logo|印刷|丝印|烫金|烫印|刺绣|绣花|贴牌|印图|激光|刻字|可加|打样/
const BRAND = /品牌|商标|专利|迪士尼|漫威|NBA|卡通|联名/

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a) }

async function get(url, ua = UA, timeout = 20000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': ua, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    })
    if (!r.ok) return null
    return await r.text()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

const clean = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/** 360 搜索：返回 offer 链接 + 标题 + 摘要里的价格 */
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

/** 搜狗：只取链接 */
function parseSogou(html) {
  const ids = new Set()
  for (const m of html.matchAll(/offer\/(\d{6,})\.html/g)) ids.add(m[1])
  return [...ids].map((id) => ({ url: `https://detail.1688.com/offer/${id}.html`, offerId: id, title: '', desc: '', priceCny: null }))
}

/** 移动端详情页：标题 / 价格 / 主图 / 描述片段 */
async function fetchDetail(offerId) {
  const html = await get(`https://m.1688.com/offer/${offerId}.html`, MOBILE_UA, 20000)
  if (!html) return null
  const title = clean(html.match(/<title>([^<]{5,150})<\/title>/)?.[1] ?? '').replace(/[-–—|｜]\s*(阿里巴巴|1688).*$/i, '')
  if (!title) return null
  const priceM = html.match(/[¥￥]\s*(\d{1,4}(?:\.\d{1,2})?)/)
  const img = html.match(/(https:\/\/cbu01\.alicdn\.com\/[^"'\\\s]+\.(?:jpg|png|webp))/i)?.[1] ?? ''
  const descM = html.match(/<meta[^>]+name="description"[^>]+content="([^"]{20,400})"/i)?.[1] ?? ''
  return {
    title,
    priceCny: priceM ? Number(priceM[1]) : null,
    images: img ? [img] : [],
    description: clean(descM),
  }
}

async function api(path, opts = {}) {
  const r = await fetch(SITE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-sync-token': TOKEN, ...(opts.headers || {}) },
  })
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text.slice(0, 300) }
  return { status: r.status, body }
}

async function main() {
  if (!TOKEN) throw new Error('缺少 SYNC_TOKEN 环境变量')

  const day = Math.floor(Date.now() / 86400000)
  const fromEnv = (process.env.KEYWORDS || '').split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)
  const start = day % POOL.length
  const keywords = fromEnv.length ? fromEnv.slice(0, 4) : [0, 1, 2, 3].map((i) => POOL[(start + i) % POOL.length])
  log('搜索词:', keywords.join('、'))

  // ① 搜索
  const hits = new Map()
  for (const kw of keywords) {
    const [so, sg] = await Promise.all([
      get(`https://www.so.com/s?q=${encodeURIComponent(`site:detail.1688.com ${kw}`)}`),
      get(`https://www.sogou.com/web?query=${encodeURIComponent(`site:detail.1688.com ${kw}`)}`),
    ])
    for (const h of so ? parse360(so) : []) if (!hits.has(h.offerId)) hits.set(h.offerId, { ...h, keyword: kw })
    for (const h of sg ? parseSogou(sg) : []) if (!hits.has(h.offerId)) hits.set(h.offerId, { ...h, keyword: kw })
    log(`「${kw}」累计 ${hits.size} 条`)
    await new Promise((r) => setTimeout(r, 1500)) // 放慢一点，降低被搜索站限流的概率
  }
  if (!hits.size) { log('没有搜到任何 1688 链接，退出'); return }

  // ② 粗筛（放宽）
  const cands = [...hits.values()]
    .filter((h) => h.priceCny == null || (h.priceCny >= 0.5 && h.priceCny <= 150))
    .map((h) => ({ ...h, cross: CROSS_BORDER.test(`${h.title} ${h.desc}`) }))
    .sort((a, b) => Number(b.cross) - Number(a.cross))
  log(`粗筛后 ${cands.length} 条候选`)

  // ③ 抓详情 + 组装
  // 1688 对无 Cookie 的请求基本都返回反爬桩页（详情抓不到是常态），
  // 所以详情失败不丢候选：退化成用搜索结果里的标题/价格/摘要导入，详情等你在站上点「评估」时再抓。
  const items = []
  let detailOk = 0
  for (const c of cands) {
    if (items.length >= LIMIT) break
    const d = await fetchDetail(c.offerId)
    const title = d?.title || c.title
    const priceCny = d?.priceCny ?? c.priceCny ?? null
    const desc = d?.description || c.desc || ''
    if (!title) { log('无标题，跳过', c.offerId); continue }
    if (d) detailOk++
    const text = `${title} ${desc}`
    if (!CUSTOM.test(text) && BRAND.test(title)) { log('自带品牌且不支持定制，跳过', c.offerId); continue }
    const signals = []
    if (c.cross) signals.push('跨境/外贸信号')
    if (CUSTOM.test(text)) signals.push('支持定制')
    if (priceCny) signals.push(`1688 报价 ¥${priceCny}`)
    if (!d) signals.push('详情页被反爬拦截（已按搜索结果导入，需在站内补抓）')
    items.push({
      source: {
        sourceUrl: c.url,
        sourceTitle: title,
        description: desc,
        sourceKeywords: [],
        amazonTitle: '',
        priceCny: priceCny ?? undefined,
        moq: undefined,
        supplier: '',
        materialCn: '',
        colorsCn: '',
        sizeCn: '',
        images: d?.images ?? [],
        category: '',
        notes: '',
      },
      selectionReason: `搜索词「${c.keyword}」命中；${signals.join('、') || '价格/标题命中'}`,
    })
    log('候选:', title.slice(0, 30), d ? '(详情OK)' : '(仅搜索结果)')
  }
  log(`详情抓取成功 ${detailOk} / 候选 ${items.length}`)
  if (!items.length) { log('没有可导入的候选，退出'); return }

  // ④ 导入
  const imp = await api('/api/products/import', { method: 'POST', body: JSON.stringify({ items }) })
  log('导入结果', imp.status, JSON.stringify(imp.body).slice(0, 200))
  if (imp.status === 401) {
    throw new Error(
      '导入被拒（401）：网站那边还没配 SYNC_TOKEN。去 Render → 你的服务 → Environment，' +
        '新增 SYNC_TOKEN，值要和本仓库 Secrets 里的 SYNC_TOKEN 完全一致，保存后等重新部署完成再跑一次。'
    )
  }
  if (imp.status !== 200) throw new Error('导入失败')
  const created = imp.body.created || []

  // ⑤ 逐条 AI 评估 + v2（串行，一条一条来，避免打爆实例）
  for (const c of created) {
    const ev = await api(`/api/products/${c.id}/evaluate`, { method: 'POST', body: '{}' })
    log('评估', c.title.slice(0, 24), ev.status)
    await api(`/api/products/${c.id}/rescore`, { method: 'POST', body: '{}' })
    await new Promise((r) => setTimeout(r, 1500))
  }
  log(`完成：导入 ${created.length} 条`)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
