import { forbiddenHits, sanitizeProductCopy, singleParagraph } from '../services/listing-copy'
import { applyQc } from '../services/workbench'
import type { Listing } from '../types'

/**
 * 2026-11-10 用户第 N 次反馈：详细描述里仍然频繁出现运输、派发、克重、箱规这些内容，
 * 而且会换行。提示词已经写过三轮仍会漏，所以加了程序侧硬过滤：整句剔除 + 压成单段落。
 */

const PRODUCT_ONLY =
  'A double-wall vacuum insulated tumbler keeps drinks cold for hours. The powder-coated body resists scratches and the threaded lid seals tight, so it works for commutes, desk use and outdoor trips.'

describe('详情描述只描述产品：整句剔除', () => {
  test('运输 / 派发 / 打样 / 起订量 的句子全部删掉', () => {
    const text = [
      PRODUCT_ONLY,
      'Fast shipping from our own factory and easy sampling for new buyers.',
      'Low MOQ and OEM service are welcome, price is negotiable.',
      'It is easy to hand out at trade shows and great for bulk distribution.',
    ].join(' ')
    const { text: clean, removed } = sanitizeProductCopy(text, 800)
    expect(clean).toContain('double-wall vacuum insulated tumbler')
    expect(removed).toHaveLength(3)
    expect(clean).not.toMatch(/shipping|sampl|MOQ|OEM|hand out|distribution/i)
  })

  test('克重与箱规数字的句子删掉', () => {
    const text = `${PRODUCT_ONLY} Each piece weighs 17 g and the carton measures 50 x 40 x 40 cm with 200 pcs per carton.`
    const { text: clean, removed } = sanitizeProductCopy(text, 800)
    expect(removed.length).toBe(1)
    expect(clean).not.toMatch(/\b17\s*g\b|\bcm\b|carton/i)
  })

  test('正常产品句子不会被误删', () => {
    const { text: clean, removed } = sanitizeProductCopy(PRODUCT_ONLY, 800)
    expect(removed).toHaveLength(0)
    expect(clean).toBe(PRODUCT_ONLY)
  })

  test('换行被压成单段落', () => {
    const multi = 'Line one about the product.\nLine two about the material.\r\nLine three.'
    expect(singleParagraph(multi)).toBe('Line one about the product. Line two about the material. Line three.')
  })

  test('超长描述按句子边界截断，不超过 800', () => {
    const long = `${PRODUCT_ONLY} `.repeat(12)
    const { text: clean } = sanitizeProductCopy(long, 800)
    expect(clean.length).toBeLessThanOrEqual(800)
    expect(clean.endsWith('.')).toBe(true)
  })

  test('全部句子都被剔除时保留原文（留给 QC 提示人工重生成）', () => {
    const onlyLogistics = 'Fast shipping and low MOQ. Free samples available.'
    const { text: clean } = sanitizeProductCopy(onlyLogistics, 800)
    expect(clean.length).toBeGreaterThan(0)
  })
})

describe('forbiddenHits 分类', () => {
  test('认得克重、箱规、运输、派发', () => {
    expect(forbiddenHits('Weighs 17g per piece')).toContain('克重/重量')
    expect(forbiddenHits('Carton size 50 x 40 x 40 cm')).toContain('箱规/尺寸/包装')
    expect(forbiddenHits('Fast delivery to your door')).toContain('运输方式/物流')
    expect(forbiddenHits('Easy to hand out at events')).toContain('派发/分发')
  })

  test('干净的产品句没有命中', () => {
    expect(forbiddenHits(PRODUCT_ONLY)).toHaveLength(0)
  })
})

describe('applyQc 自动清洗描述', () => {
  const listing = (description: string): Listing =>
    ({
      title: 'Stainless Steel Insulated Tumbler 20oz',
      summary: 'Double wall vacuum insulated tumbler keeps drinks cold for hours. Rush service is available',
      description,
      keywords: Array.from({ length: 30 }, (_, i) => `Keyword ${i}`),
      category: 'Bottles-Insulated',
      themes: ['Anniversary', 'Sustainable', 'Corporate', 'Camping', 'Outdoor'],
      material: 'Stainless Steel',
      materials: ['Stainless Steel'],
      colors: 'Black',
      colorChips: ['Black'],
      imprintMethods: ['Silkscreen', 'Unimprinted', 'Full Color'],
      warnings: [],
      titleZh: '',
      summaryZh: '',
      descriptionZh: '',
      keywordsZh: '',
      priceGrid: [],
      packaging: '',
      productionTime: '',
      imprintArea: '',
    }) as unknown as Listing

  test('运输句被剔除、换行被压平，并在 QC issues 里说明', () => {
    const out = applyQc(
      listing(`${PRODUCT_ONLY}\nFast shipping and easy sampling. The carton holds 200 pcs.`)
    )
    expect(out.description).not.toMatch(/shipping|sampling|carton/i)
    expect(out.description).not.toMatch(/[\r\n]/)
    expect((out.qc?.issues ?? []).join(' ')).toMatch(/剔除/)
  })

  test('本来干净的描述原样保留', () => {
    const out = applyQc(listing(PRODUCT_ONLY))
    expect(out.description).toBe(PRODUCT_ONLY)
  })
})
