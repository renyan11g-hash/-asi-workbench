import { applyQc } from '../services/workbench'
import type { Listing } from '../types'

const RUSH = 'Rush service is available'

function listing(over: Partial<Listing> = {}): Listing {
  return {
    title: 'Stainless Steel Insulated Tumbler 20oz',
    summary: `Double wall tumbler keeps drinks cold for hours. ${RUSH}`,
    description: 'A durable tumbler built for everyday commutes and office desks.',
    keywords: Array.from({ length: 30 }, (_, i) => `Sample ${i}`),
    category: 'Bottles-Insulated',
    categories: ['Bottles-Insulated'],
    typeOfProduct: 'Drinkware',
    themes: ['Anniversary', 'Sustainable', 'Corporate', 'Camping', 'Outdoor'],
    material: 'Stainless Steel',
    materials: ['Stainless Steel'],
    colors: 'Black/White',
    colorChips: ['Black', 'White'],
    imprintMethods: ['Silkscreen', 'Unimprinted', 'Full Color'],
    productSizeInch: '8" H',
    productSizeCm: { l: 7, w: 7, h: 20 },
    unitWeightLb: 0.66,
    cartonSizeInch: '16 x 12 x 10',
    cartonGwLb: 26,
    priceGrid: [],
    packaging: 'Poly bag',
    productionTime: '5-7 business days after proof approval',
    imprintArea: 'Front: 2" x 2"',
    warnings: [],
    titleZh: '',
    summaryZh: '',
    descriptionZh: '',
    keywordsZh: '',
    ...over,
  }
}

describe('关键词补齐：产品名词 + 属性', () => {
  it('不足 30 组时用「属性 + 产品名词」补齐，且不出现服务承诺词', () => {
    const out = applyQc(listing({ keywords: ['Insulated Bottle', 'Vacuum Flask'] }))
    expect(out.keywords).toHaveLength(30)
    const joined = out.keywords.join(' | ')
    expect(joined).not.toMatch(/Factory Direct|Fast Lead Time|OEM Service|Low MOQ/i)
    // 补齐词围绕产品本身（Tumbler / Bottles），不是 Custom / Client Thank You 这种泛词
    expect(out.keywords.some((k) => /tumbler|bottles/i.test(k))).toBe(true)
  })

  it('物理属性只取文案里出现过的词：玻璃瓶不会被补成 Foldable / Vacuum', () => {
    const out = applyQc(
      listing({
        title: 'Glass Water Bottle',
        description: 'A clear glass bottle with a screw lid for office desks.',
        category: 'Bottles-Glass',
        categories: ['Bottles-Glass'],
        material: 'Glass',
        materials: ['Glass'],
        keywords: [],
      })
    )
    expect(out.keywords).toHaveLength(30)
    expect(out.keywords.join(' ')).not.toMatch(/Foldable|Vacuum|Insulated|Leakproof/i)
  })

  it('单复数归一：Bottle 与 Bottles 不会各占一组', () => {
    const out = applyQc(listing({ keywords: ['Bottle', 'Bottles'] }))
    const bottleGroups = out.keywords.filter((k) => /^bottle(s)?$|\bbottle(s)?\b/i.test(k))
    expect(bottleGroups).toHaveLength(1)
  })

  it('每组 ≤30 字符、≤4 词（含补齐词）', () => {
    const out = applyQc(listing({ keywords: ['Insulated Bottle'] }))
    expect(out.keywords).toHaveLength(30)
    for (const k of out.keywords) {
      expect(k.length).toBeLessThanOrEqual(30)
      expect(k.split(/\s+/).length).toBeLessThanOrEqual(4)
    }
  })

  it('已经满 30 组时不追加补齐词', () => {
    const kws = Array.from({ length: 30 }, (_, i) => `Widget${i}`)
    const out = applyQc(listing({ keywords: kws }))
    expect(out.keywords).toEqual(kws)
  })
})
