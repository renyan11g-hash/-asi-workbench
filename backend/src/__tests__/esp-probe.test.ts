/**
 * ESP（supplier.espwebsite.com = 全 ASI 供应商目录）探针测试。
 *
 * 背景：早先差异化只按 4imprint（单一分销商，最多 28 条）判断，
 * "4imprint 只有 1 条命中" 被当成"薄品类、差异化高"，与真实市场相反。
 * 这里锁死三件事：
 *   1. 页面解析（总数 / 类目分面 / 产品卡片）不能错位；
 *   2. 供给密度以 ESP 全站口径为准，4imprint 只作补充；
 *   3. 任何一路挂掉都不能让评估流程拿不到数据（降级而不是失败）。
 */

import { espDensityScore, parseEspResults } from '../services/esp-probe'

/** 造一页 ESP 搜索结果（结构照抄线上真实 DOM，只保留用得到的部分） */
function espPage(opts: {
  total: string
  cats?: Array<[string, number]>
  items?: Array<{ id: string; title: string; no: string; price: string; desc?: string }>
}) {
  const cats = (opts.cats ?? [])
    .map(
      ([name, count]) =>
        `<li><a href="#" onclick='javascript:SelectDimStats("CTGR","${name}","${count}"); SelectDimension("1","${name}","CTGR:${name}"); return false;'><span>${name}</span>&nbsp;<span class="prdrebCount">(${count})</span></a></li>`
    )
    .join('\n')
  const items = (opts.items ?? [])
    .map(
      (it) => `
<div id="ctl03_ctl01_records_RptProductsGrid_ctl00_ItemContainer" class="col4 prodPannel RowIndex0">
  <input type="hidden" name="ctl03$ctl01$records$RptProductsGrid$ctl00$productId" id="x_productId" value="${it.id}" />
  <div class="prodTile alignCenter">
    <div class="prodImg p_Img_Title"><a href="javascript:__doPostBack(&#39;x&#39;,&#39;&#39;)"><img alt="${it.title}" data-original="https://media-asicdn.azureedge.net/images/jpgt/1/${it.id}.jpg" /></a></div>
    <div class="prodName lnkquickview0"><div class="ellipsis"><a href="javascript:__doPostBack(&#39;y&#39;,&#39;&#39;)"><span id="x_lblTVProdName" title="${it.title}">${it.title}</span></a></div></div>
    ${it.desc ? `<div class="prodDescr">${it.desc}</div>` : ''}
    <span id="x_litProdNo" class="prodName notranslate">${it.no}</span>
    <div class="prodPrice"><div class="priceLowest styledtxt ellipsis"><span id="x_lblPrice" class="notranslate">${it.price}<span class="translate"> and up</span></span></div></div>
  </div>
</div>`
    )
    .join('\n')
  return `<html><body>
<span id="ltAlgoliaProductCount" class="prdrebResCount"> ${opts.total} </span> item(s) are found
<div class="prdrebDimensionGroup"><ul>${cats}</ul></div>
<div class="prodTileWrap">${items}</div>
</body></html>`
}

const NB_ITEMS = [
  { id: '551165698', title: 'Bamboo Cover Spiral Notebook', no: 'B-8298-T', price: '$4.25' },
  { id: '551165699', title: 'Bamboo Notebook Gift Set With Pen', no: 'MI338C', price: '$6.80' },
  { id: '551165700', title: 'Recycled Bamboo Journal Notebook', no: 'AKW105', price: '$3.90' },
]

describe('parseEspResults', () => {
  it('解析全站匹配总数、类目分面、产品卡片（含详情页链接）', () => {
    const html = espPage({
      total: '5,000+',
      cats: [
        ['NOTEBOOKS', 1200],
        ['GIFT SETS', 340],
      ],
      items: NB_ITEMS,
    })
    const r = parseEspResults(html)
    expect(r.total).toBe(5000)
    expect(r.categories).toEqual([
      { name: 'NOTEBOOKS', count: 1200 },
      { name: 'GIFT SETS', count: 340 },
    ])
    expect(r.items).toHaveLength(3)
    expect(r.items[0]).toMatchObject({
      title: 'Bamboo Cover Spiral Notebook',
      productNo: 'B-8298-T',
      priceMin: 4.25,
    })
    // 详情页链接必须能直接点开（用户要的是链接清单，不是搜索词）
    expect(r.items[0].url).toBe(
      'https://supplier.espwebsite.com/ProductDetails/?productId=551165698&PCUrl=1'
    )
  })

  it('没有价格的卡片整条丢弃，不会把后面卡片的价格错位给它', () => {
    const html = espPage({
      total: '120+',
      items: [
        { id: '1', title: 'Bamboo Notebook A', no: 'A1', price: 'no-price' },
        { id: '2', title: 'Bamboo Notebook B', no: 'A2', price: '$5.55' },
      ],
    })
    const r = parseEspResults(html)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ title: 'Bamboo Notebook B', priceMin: 5.55 })
  })

  it('0 条结果（真没匹配）读得出 total=0 且没有卡片', () => {
    const html = espPage({ total: '0+' })
    const r = parseEspResults(html)
    expect(r.total).toBe(0)
    expect(r.items).toHaveLength(0)
  })

  it('HTML 实体解码（&amp; / &quot;）', () => {
    const html = espPage({
      total: '9+',
      items: [{ id: '3', title: 'Bamboo Notebook 10&quot; x 13&quot; &amp; Pen', no: 'X', price: '$2.10' }],
    })
    const r = parseEspResults(html)
    expect(r.items[0].title).toBe('Bamboo Notebook 10" x 13" & Pen')
  })

  it('jina 渲染回来的页面把 onclick 里的引号转义成 &quot;，类目分面照样要解析出来', () => {
    // sidejina（供机房 IP 用）序列化后 onclick='SelectDimStats(&quot;CTGR&quot;,&quot;NOTEBOOKS&quot;,&quot;153&quot;)'
    const html = `<html><body>
<span id="ltAlgoliaProductCount" class="prdrebResCount"> 260+ </span> item(s) are found
<ul><li><a href="#" onclick="javascript:SelectDimStats(&quot;CTGR&quot;,&quot;NOTEBOOKS&quot;,&quot;153&quot;); SelectDimension(&quot;1&quot;,&quot;NOTEBOOKS&quot;,&quot;CTGR:NOTEBOOKS&quot;); return false;"><span>NOTEBOOKS</span>&nbsp;<span class="prdrebCount">(153)</span></a></li>
<li><a href="#" onclick="javascript:SelectDimStats(&quot;CTGR&quot;,&quot;GIFT SETS&quot;,&quot;62&quot;);"><span>GIFT SETS</span>&nbsp;<span class="prdrebCount">(62)</span></a></li></ul>
</body></html>`
    const r = parseEspResults(html)
    expect(r.total).toBe(260)
    expect(r.categories).toEqual([
      { name: 'NOTEBOOKS', count: 153 },
      { name: 'GIFT SETS', count: 62 },
    ])
  })
})

describe('espDensityScore', () => {
  it('全站匹配越多，供给密度分越低（分档，不搞线性假精确）', () => {
    expect(espDensityScore(0)).toBe(96)
    expect(espDensityScore(50)).toBe(88)
    expect(espDensityScore(200)).toBe(76)
    expect(espDensityScore(500)).toBe(62)
    expect(espDensityScore(2000)).toBe(48)
    expect(espDensityScore(5000)).toBe(34)
    expect(espDensityScore(50000)).toBe(22)
  })
})

/* ---------- 以下测两路合并：需要 mock fetch，所以在设置全局 fetch 之后再 require ---------- */

type Route = { status?: number; body?: string } | 'throw'

function mockFetch(routes: Array<[match: string, r: Route]>) {
  const fn = jest.fn(async (url: string) => {
    const hit = routes.find(([match]) => url.includes(match))
    const r = hit?.[1] ?? 'throw'
    if (r === 'throw') throw new Error(`network down for ${url}`)
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => r.body ?? '',
    }
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return fn
}

/** 4imprint RSS 一页（价格区间写在 description 里，取最后一组） */
function rssPage(items: Array<{ title: string; min: number; max: number }>) {
  const body = items
    .map(
      (it) =>
        `<item><title>${it.title}</title><link>https://www.4imprint.com/product/${encodeURIComponent(
          it.title
        )}</link><description>Original Price from $${it.max} - $${it.max}. Sale Price from only $${it.min} - $${it.max}</description></item>`
    )
    .join('\n')
  return `<rss><channel>${body}</channel></rss>`
}

function loadProbe() {
  jest.resetModules()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../services/market-probe') as typeof import('../services/market-probe')
}

const opts = { coreKeywords: ['bamboo', 'notebook'], productType: 'Bamboo Notebook' }

describe('probeWithDiag — 两路合并', () => {
  it('密度以 ESP 全站为准：4imprint 只有 1 条同类不再等于"差异化高"', async () => {
    mockFetch([
      [
        '4imprint.com',
        {
          body: rssPage([
            { title: 'Bamboo Notebook', min: 3.2, max: 4.1 },
            { title: 'Ceramic Mug', min: 2.4, max: 3.1 },
            { title: 'Travel Tumbler', min: 5.1, max: 6.4 },
          ]),
        },
      ],
      [
        'espwebsite.com',
        {
          body: espPage({
            total: '5,000+',
            cats: [['NOTEBOOKS', 1200]],
            items: NB_ITEMS,
          }),
        },
      ],
    ])
    const { probeWithDiag } = loadProbe()
    const diag = await probeWithDiag(['bamboo notebook'], 5000, opts)
    const s = diag.snapshot
    expect(s).toBeTruthy()
    // 4imprint 那边只有 1 条真同类（旧算法会给出 92 分的密度）
    expect(s!.matched).toBe(1)
    // 合并后按 ESP 的 5000 条口径 → 34 分
    expect(s!.esp?.total).toBe(5000)
    expect(s!.densityScore).toBe(34)
    // 竞争分现在还要叠加需求侧（4imprint 算 1 家 carrier），所以不再等于密度分
    expect(s!.competitionEstimate).toBeLessThan(50)
    expect(s!.diffEstimate).toBeLessThan(60)
    expect(s!.esp?.items[0].url).toContain('/ProductDetails/?productId=')
  })

  it('ESP 完全取不到时退回 4imprint 28 条口径（降级不失败）', async () => {
    mockFetch([
      [
        '4imprint.com',
        {
          body: rssPage([
            { title: 'Bamboo Notebook A', min: 3.2, max: 4.1 },
            { title: 'Bamboo Notebook B', min: 3.4, max: 4.4 },
            { title: 'Bamboo Notebook C', min: 3.8, max: 4.9 },
            { title: 'Bamboo Notebook D', min: 4.1, max: 5.2 },
            { title: 'Bamboo Notebook E', min: 4.4, max: 5.6 },
          ]),
        },
      ],
      ['espwebsite.com', 'throw'],
    ])
    const { probeWithDiag } = loadProbe()
    const diag = await probeWithDiag(['bamboo notebook'], 5000, opts)
    expect(diag.snapshot?.esp).toBeUndefined()
    // 5 条同类 → 78 分（沿用老口径）
    expect(diag.snapshot?.densityScore).toBe(78)
    expect(diag.esp?.error).toBeTruthy()
  })

  it('4imprint 挂了但 ESP 有数据：仍然出评估证据，竞品来自 ESP', async () => {
    mockFetch([
      ['4imprint.com', 'throw'],
      ['espwebsite.com', { body: espPage({ total: '260+', items: NB_ITEMS }) }],
    ])
    const { probeWithDiag } = loadProbe()
    const diag = await probeWithDiag(['bamboo notebook'], 5000, opts)
    const s = diag.snapshot
    expect(s).toBeTruthy()
    expect(s!.esp?.total).toBe(260)
    expect(s!.items.length).toBeGreaterThan(0)
    expect(s!.items[0].url).toContain('espwebsite.com')
    expect(s!.price?.p25).toBeGreaterThan(0)
    expect(s!.relevanceNote ?? '').toContain('4imprint')
  })

  it('ESP 返回泛匹配兜底页（标题全不相干）时不拿它定密度', async () => {
    mockFetch([
      [
        '4imprint.com',
        {
          body: rssPage([
            { title: 'Bamboo Notebook A', min: 3.2, max: 4.1 },
            { title: 'Bamboo Notebook B', min: 3.4, max: 4.4 },
            { title: 'Bamboo Notebook C', min: 3.8, max: 4.9 },
          ]),
        },
      ],
      [
        'espwebsite.com',
        {
          body: espPage({
            total: '21,498+',
            items: [
              { id: '9', title: '16 oz Travel Mug', no: 'M1', price: '$4.99' },
              { id: '10', title: 'LED Martini Glass', no: 'M2', price: '$3.24' },
            ],
          }),
        },
      ],
    ])
    const { probeWithDiag } = loadProbe()
    const diag = await probeWithDiag(['bamboo notebook'], 5000, opts)
    const s = diag.snapshot
    expect(s!.esp?.fallback).toBe(true)
    // 兜底页不可信 → 密度回到 4imprint 的 3 条同类口径
    expect(s!.densityScore).toBe(92)
    expect(s!.esp?.relevanceNote ?? '').toContain('泛匹配')
  })

  it('直连被 Cloudflare 挡成 403 时自动改走 jina 渲染，解析结果一致', async () => {
    // 顺序很重要：jina 的 URL 里也含 espwebsite.com，必须排在前面先命中
    mockFetch([
      ['r.jina.ai', { body: espPage({ total: '260+', cats: [['NOTEBOOKS', 153]], items: NB_ITEMS }) }],
      ['espwebsite.com', { status: 403, body: '<html>blocked</html>' }],
    ])
    jest.resetModules() // 页面缓存是模块级的，换 mock 前必须清掉，否则会读到上一条用例的缓存
    const { probeEspWithDiag } = require('../services/esp-probe') as typeof import('../services/esp-probe')
    const diag = await probeEspWithDiag(['bamboo notebook'], 5000, opts)
    expect(diag.snapshot?.total).toBe(260)
    expect(diag.snapshot?.categories[0]).toEqual({ name: 'NOTEBOOKS', count: 153 })
    expect(diag.snapshot?.items).toHaveLength(3)
    expect(diag.perQuery[0].via).toBe('jina')
    expect(diag.perQuery[0].ok).toBe(true)
  })

  it('返回 200 但其实是挑战页（没有结果结构）也算失败，不会误判成 0 条', async () => {
    mockFetch([
      ['espwebsite.com', { body: '<html><title>Just a moment...</title>checking your browser</html>' }],
    ])
    jest.resetModules() // 页面缓存是模块级的，换 mock 前必须清掉，否则会读到上一条用例的缓存
    const { probeEspWithDiag } = require('../services/esp-probe') as typeof import('../services/esp-probe')
    const diag = await probeEspWithDiag(['bamboo notebook'], 5000, opts)
    expect(diag.snapshot).toBeNull()
    expect(diag.error).toBeTruthy()
  })

  it('多家分销商都在卖同类时，竞争分被需求拉低（不能只报"供给少＝好机会"）', async () => {
    const qlp = `<span class="js-total-results">20 Items</span>
      <div class="prod-box-cat"><a href="/notebook-sets/a.htm" class="prod-box-cat__info-title">Bamboo Notebook Gift Set</a>
      <p class="prod-box__info-price">As Low As <strong>$7.20</strong> ea.</p></div>
      <div class="prod-box-cat"><a href="/notebook-sets/b.htm" class="prod-box-cat__info-title">Bamboo Notebook and Pen Set</a>
      <p class="prod-box__info-price">As Low As <strong>$5.90</strong> ea.</p></div>
      <div class="prod-box-cat"><a href="/notebook-sets/c.htm" class="prod-box-cat__info-title">Bamboo Journal Notebook Kit</a>
      <p class="prod-box__info-price">As Low As <strong>$6.40</strong> ea.</p></div>`
    mockFetch([
      ['4imprint.com', { body: rssPage([{ title: 'Bamboo Notebook', min: 3.2, max: 4.1 }]) }],
      ['qualitylogoproducts.com', { body: qlp }],
      ['espwebsite.com', { body: espPage({ total: '5,000+', items: NB_ITEMS }) }],
    ])
    const { probeWithDiag } = loadProbe()
    const diag = await probeWithDiag(['bamboo notebook'], 5000, opts)
    const s = diag.snapshot!
    expect(s.demand).toBeTruthy()
    // 4imprint 也算一家分销商：它 1 条 + QLP 3 条 = 2 家在卖
    expect(s.demand!.carriers).toBe(2)
    expect(s.demand!.demandScore).toBeGreaterThanOrEqual(45)
    // 供给密度 34（ESP 5000 条），但分销商在卖 → 竞争更难，分更低
    expect(s.densityScore).toBe(34)
    expect(s.competitionEstimate).toBeLessThan(45)
    expect(
      s.demand!.sources.find((x) => x.id === 'qlp')?.items.some((i) => i.url.includes('qualitylogoproducts.com/notebook-sets/'))
    ).toBe(true)
  })

  it('不在卖（0 家）时需求分很低，交给闸门压总分', async () => {
    mockFetch([
      // 4imprint 目录里也没有同类（否则它自己就算一家 carrier）
      ['4imprint.com', { body: rssPage([{ title: 'Ceramic Mug', min: 3.2, max: 4.1 }]) }],
      [
        'qualitylogoproducts.com',
        { body: '<span class="js-total-results">0 Items</span><div class="prod-box-cat"></div>' },
      ],
      ['espwebsite.com', { body: espPage({ total: '30+', items: NB_ITEMS }) }],
    ])
    const { probeWithDiag } = loadProbe()
    const s = (await probeWithDiag(['bamboo notebook'], 5000, opts)).snapshot!
    expect(s.demand!.carriers).toBe(0)
    expect(s.demand!.demandScore).toBe(20)
    // 供给少 → 密度分高，但需求为 0 会在 composeScore 里封顶（见 distributor-probe 测试）
    expect(s.densityScore).toBeGreaterThan(80)
  })

  it('同一个搜索词在 30 分钟内只用抓一次页面（批量选品不重复打站点）', async () => {
    const fetchMock = mockFetch([
      [
        '4imprint.com',
        { body: rssPage([{ title: 'Bamboo Notebook', min: 3.2, max: 4.1 }]) },
      ],
      ['espwebsite.com', { body: espPage({ total: '260+', items: NB_ITEMS }) }],
    ])
    const { probeWithDiag } = loadProbe()
    await probeWithDiag(['bamboo notebook'], 5000, opts)
    const first = fetchMock.mock.calls.filter((c) => String(c[0]).includes('espwebsite.com')).length
    await probeWithDiag(['bamboo notebook'], 5000, opts)
    const second = fetchMock.mock.calls.filter((c) => String(c[0]).includes('espwebsite.com')).length
    expect(first).toBe(1)
    expect(second).toBe(1)
  })
})
