/**
 * 分销商需求侧探针 + 形态识别 + 需求闸门测试。
 *
 * 三件事必须锁死：
 *   1. 套装和单件不能混着比价（用户明确提过：三件套 vs 两件套价格天然不同）；
 *   2. 需求侧要看多家分销商，不是只盯 4imprint 一家；
 *   3. 0 家分销商在卖 = 需求未验证 → 总分必须被闸门压到 MAYBE 以下，不能当成"蓝海"。
 */

import { formOfSource, formOfTitle } from '../services/market-text'
import { distributorDemandScore, parsePrintglobe, parseQlp, summarizeDemand } from '../services/distributor-probe'
import { composeScore } from '../services/eval-score'
import type { DistributorSource } from '../services/distributor-probe'

describe('分销商页面解析', () => {
  it('Quality Logo Products：读总数 + 卡片标题/最低价/商品链接', () => {
    const html = `
      <span class="js-total-results no-mobile no-desktop">17 Items</span>
      <div class="prod-box-cat" data-prodid="44120">
        <a href="/custom-notepads/bamboo-notebook-and-pen.htm" class="prod-box-cat__info-title prod-box-cat__info-title--yes-mobile">Bamboo Notebook and Pens</a>
        <p class="prod-box__info-price" tabindex="-1">As Low As <strong>$6.59</strong> ea.</p>
      </div>
      <div class="prod-box-cat" data-prodid="44121">
        <a href="/notebook-sets/bamboo-notebook-with-pen-stickynotes.htm" class="prod-box-cat__info-title">Bamboo Notebooks with Pen and Sticky Notes</a>
        <p class="prod-box__info-price" tabindex="-1">As Low As <strong>$2.56</strong> ea.</p>
      </div>`
    const r = parseQlp(html)
    expect(r.total).toBe(17)
    expect(r.items).toHaveLength(2)
    expect(r.items[0]).toMatchObject({
      title: 'Bamboo Notebook and Pens',
      priceMin: 6.59,
      url: 'https://www.qualitylogoproducts.com/custom-notepads/bamboo-notebook-and-pen.htm',
      form: 'set',
    })
  })

  it('PrintGlobe：从 aria-label 里拆出标题 / 货号 / 价格', () => {
    const html = `
      <a class="product-card-link" aria-label="Albany Bamboo Notebooks with Pen, Item #JOU0182, Price from $9.32" href="/albany-bamboo-notebooks-with-pen/102367">
      <a class="product-card-link" aria-label="Recycled Bamboo Fiber Bound Notebooks, Item #JOU0198, Price from $6.14" href="/recycled-bamboo-fiber/106465">`
    const r = parsePrintglobe(html)
    expect(r.items).toHaveLength(2)
    expect(r.items[0]).toMatchObject({
      title: 'Albany Bamboo Notebooks with Pen',
      sku: 'JOU0182',
      priceMin: 9.32,
      url: 'https://www.printglobe.com/albany-bamboo-notebooks-with-pen/102367',
      form: 'set',
    })
    expect(r.items[1].form).toBe('single')
  })
})

describe('形态识别（套装 vs 单件）', () => {
  it('中文标题能认出套装', () => {
    expect(formOfSource('竹面笔记本+茶渣环保杯+笔筒+牛皮礼盒 三件套')).toBe('set')
    expect(formOfSource('商务礼盒套装')).toBe('set')
    expect(formOfSource('竹面笔记本')).toBe('unknown')
    expect(formOfSource('单件竹面笔记本')).toBe('single')
  })

  it('英文标题能认出套装：set/kit/combo/3-in-1/带配件', () => {
    expect(formOfTitle('Bamboo Notebook Gift Set')).toBe('set')
    expect(formOfTitle('3-in-1 Bamboo Spiral Notebook Gift Set With Pen')).toBe('set')
    expect(formOfTitle('Bamboo Notebooks with Pen and Sticky Notes')).toBe('set')
    expect(formOfTitle('Bamboo Notebook and Pen')).toBe('set')
    expect(formOfTitle('Desktop Kit')).toBe('set')
    // 单件不能被误判成套
    expect(formOfTitle('Recycled Bamboo Fiber Notebook')).toBe('single')
    expect(formOfTitle('Bamboo Cover Spiral Notebook Journal')).toBe('single')
    expect(formOfTitle('Bamboo Notebook with Elastic Closure')).toBe('single')
  })
})

function src(partial: Partial<DistributorSource> & { id: string; name: string }): DistributorSource {
  return {
    ok: true,
    total: 20,
    sampleSize: 20,
    matched: 0,
    sameFormCount: 0,
    price: null,
    priceSameForm: null,
    items: [],
    ...partial,
  }
}

describe('分销商需求汇总', () => {
  it('多家都在卖 → 需求已验证，分数高', () => {
    const s = summarizeDemand([
      src({ id: 'a', name: 'A', matched: 30 }),
      src({ id: 'b', name: 'B', matched: 12 }),
      src({ id: 'c', name: 'C', matched: 4 }),
    ])
    expect(s.carriers).toBe(3)
    expect(s.bestCount).toBe(30)
    expect(s.demandScore).toBeGreaterThanOrEqual(90)
    expect(s.note).toContain('都在卖')
  })

  it('一家都没在卖 → 需求未验证，分数很低，结论里必须点明', () => {
    const s = summarizeDemand([
      src({ id: 'a', name: 'A', matched: 0 }),
      src({ id: 'b', name: 'B', matched: 0 }),
    ])
    expect(s.carriers).toBe(0)
    expect(s.demandScore).toBe(20)
    expect(s.note).toContain('需求未验证')
  })

  it('只有 1 家取到数据 → 说明证据偏薄，不能说成全网结论', () => {
    const s = summarizeDemand([
      src({ id: 'a', name: 'A', matched: 6 }),
      src({ id: 'b', name: 'B', ok: false, matched: 0 }),
    ])
    expect(s.carriers).toBe(1)
    expect(s.note).toContain('偏薄')
    expect(s.note).toContain('B 这次没取到')
  })

  it('需求强度分档：0 家 < 1 家 < 2 家 < 3 家', () => {
    expect(distributorDemandScore(0, 3, 0)).toBeLessThan(distributorDemandScore(1, 3, 5))
    expect(distributorDemandScore(1, 3, 5)).toBeLessThan(distributorDemandScore(2, 3, 5))
    expect(distributorDemandScore(2, 3, 5)).toBeLessThan(distributorDemandScore(3, 3, 5))
  })
})

describe('需求闸门（composeScore）', () => {
  const strong: Parameters<typeof composeScore>[0] = {
    differentiation: 85,
    customization: 80,
    shipping: 80,
    competition: 80,
    compliance: 80,
  }

  it('五维都很高时正常给高分', () => {
    const r = composeScore(strong)
    expect(r.score).toBeGreaterThanOrEqual(75)
    expect(r.verdict).toBe('GO')
  })

  it('分销商都不卖同类 → 总分封顶 55（需求未验证不能当蓝海）', () => {
    const r = composeScore(strong, { demandMissing: true })
    expect(r.score).toBe(55)
    expect(r.verdict).toBe('MAYBE')
    expect(r.note).toContain('需求未验证')
  })

  it('需求正常时闸门不生效', () => {
    const r = composeScore(strong, { demandMissing: false })
    expect(r.score).toBeGreaterThan(55)
  })
})
