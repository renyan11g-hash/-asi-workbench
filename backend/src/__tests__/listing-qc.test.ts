import { runListingQc } from '../services/listing-qc'
import { emptySpecs } from '../services/spec-fields'
import type { Listing, SourceInfo } from '../types'

function source(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    sourceTitle: '304不锈钢保温杯 20oz',
    sourceUrl: 'https://detail.1688.com/offer/123.html',
    description: '材质：304不锈钢，容量：20oz，颜色：黑色/白色',
    sourceKeywords: [],
    amazonTitle: '',
    priceCny: 12,
    priceMaxCny: null,
    moq: 50,
    supplier: '',
    altSuppliers: '',
    materialCn: '304不锈钢',
    colorsCn: '黑色/白色',
    sizeCn: '20oz',
    weightG: 300,
    cartonLCm: 40,
    cartonWCm: 30,
    cartonHCm: 25,
    pcsPerCarton: 60,
    cartonGwKg: 12,
    images: [],
    category: '',
    notes: '',
    ...over,
  }
}

const RUSH = 'Rush service is available'

function listing(over: Partial<Listing> = {}): Listing {
  return {
    title: 'Stainless Steel Insulated Tumbler 20oz',
    summary: `Double wall vacuum insulated keeps drinks cold for hours. ${RUSH}`,
    description:
      'A durable stainless steel tumbler built for everyday commutes, office desks and outdoor trips.',
    keywords: Array.from({ length: 30 }, (_, i) => `Keyword ${i}`),
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

function check(report: ReturnType<typeof runListingQc>, key: string) {
  const c = report.checks.find((x) => x.key === key)
  if (!c) throw new Error(`没有找到检查项 ${key}`)
  return c
}

describe('Listing 质量检查（程序规则）', () => {
  it('合格文案：所有硬性检查通过', () => {
    const report = runListingQc({ listing: listing(), source: source(), specs: emptySpecs() })
    expect(check(report, 'titleLen').ok).toBe(true)
    expect(check(report, 'summaryLen').ok).toBe(true)
    expect(check(report, 'summaryRush').ok).toBe(true)
    expect(check(report, 'descriptionLen').ok).toBe(true)
    expect(check(report, 'keywordCount').ok).toBe(true)
    expect(report.ok).toBe(true)
  })

  it('标题超长 → 硬性不通过', () => {
    const report = runListingQc({ listing: listing({ title: 'A'.repeat(61) }), source: source() })
    expect(check(report, 'titleLen').ok).toBe(false)
    expect(check(report, 'titleLen').level).toBe('error')
    expect(report.ok).toBe(false)
  })

  it('Summary 没以 Rush service is available 结尾 → 硬性不通过', () => {
    const report = runListingQc({
      listing: listing({ summary: 'A great tumbler for the office.' }),
      source: source(),
    })
    expect(check(report, 'summaryRush').ok).toBe(false)
    expect(report.ok).toBe(false)
  })

  it('摘要超长 → 硬性不通过', () => {
    const report = runListingQc({
      listing: listing({ summary: `${'word '.repeat(40)}${RUSH}` }),
      source: source(),
    })
    expect(check(report, 'summaryLen').ok).toBe(false)
  })

  it('描述超长 → 硬性不通过', () => {
    const report = runListingQc({ listing: listing({ description: 'x'.repeat(801) }), source: source() })
    expect(check(report, 'descriptionLen').ok).toBe(false)
  })

  it('关键词超过 30 组 → 硬性不通过；不足 30 组只是提示', () => {
    const tooMany = runListingQc({
      listing: listing({ keywords: Array.from({ length: 31 }, (_, i) => `Term ${i}`) }),
      source: source(),
    })
    expect(check(tooMany, 'keywordCount').ok).toBe(false)
    expect(check(tooMany, 'keywordCount').level).toBe('error')

    const tooFew = runListingQc({
      listing: listing({ keywords: Array.from({ length: 20 }, (_, i) => `Term ${i}`) }),
      source: source(),
    })
    expect(check(tooFew, 'keywordCount').ok).toBe(false)
    expect(check(tooFew, 'keywordCount').level).toBe('warn')
    expect(tooFew.ok).toBe(true) // 关键词不足不拦审核
  })

  it('关键词完全重复 → 提示', () => {
    const kws = Array.from({ length: 30 }, (_, i) => (i < 2 ? 'Reusable Cup' : `Term ${i}`))
    const report = runListingQc({ listing: listing({ keywords: kws }), source: source() })
    expect(check(report, 'keywordDuplicate').ok).toBe(false)
  })

  it('编造材质（资料里没有不锈钢）→ 提示无依据', () => {
    const report = runListingQc({
      listing: listing({
        description: 'Made of premium stainless steel for long lasting use.',
        material: 'Stainless Steel',
        materials: ['Stainless Steel'],
      }),
      source: source({ sourceTitle: '木质收纳盒', materialCn: '木质', description: '材质：木质' }),
      specs: emptySpecs(),
    })
    expect(report.unsupported.join(' ')).toContain('Stainless Steel')
    expect(check(report, 'unsupportedClaims').ok).toBe(false)
  })

  it('资料里有的材质不报错', () => {
    const report = runListingQc({
      listing: listing({
        description: 'Made of premium stainless steel for long lasting use.',
      }),
      source: source(),
      specs: emptySpecs(),
    })
    expect(report.unsupported.join(' ')).not.toContain('Stainless Steel')
  })

  it('编造认证（FDA）→ 提示无依据', () => {
    const report = runListingQc({
      listing: listing({ description: 'FDA approved food grade material.' }),
      source: source({ description: '材质：304不锈钢' }),
    })
    expect(report.unsupported.join(' ')).toContain('FDA')
  })

  it('编造尺寸数字（资料里没有 24oz）→ 提示无依据', () => {
    const report = runListingQc({
      listing: listing({ description: 'Holds up to 24oz of your favorite drink.' }),
      source: source(),
    })
    expect(report.unsupported.join(' ')).toContain('24oz')
  })

  it('AI 复检是单独动作：默认标记为「还没检查」', () => {
    const report = runListingQc({ listing: listing(), source: source() })
    expect(report.needsAi).toBe(true)
    expect(report.aiChecked).toBe(false)
  })

  // 1688 页面里的「发货快、打样方便、厂家直销」不是产品卖点，不能带进英文文案
  it('描述里出现发货/打样话术 → 提示改写', () => {
    const report = runListingQc({
      listing: listing({
        description:
          'Fast shipping and easy sampling for this stainless steel tumbler. Factory direct price with low MOQ.',
      }),
      source: source(),
    })
    const c = check(report, 'noServiceTalk')
    expect(c.ok).toBe(false)
    expect(c.level).toBe('warn')
    expect(c.detail).toMatch(/shipping|sampl|factory|MOQ/i)
  })

  it('只描述产品本身 → 通过卖家话术检查', () => {
    const report = runListingQc({
      listing: listing({
        description:
          'A durable stainless steel tumbler with double wall vacuum insulation, built for commutes, desks and outdoor trips.',
      }),
      source: source(),
    })
    expect(check(report, 'noServiceTalk').ok).toBe(true)
  })
})
