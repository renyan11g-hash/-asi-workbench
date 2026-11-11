/**
 * 类目/主题选择质量（用户诉求：类目、类别、主题选错会直接影响曝光）。
 *
 * 三条底线，缺一条就会选错：
 *  1. 候选榜必须被「ASI/Amazon 同款商品的真实标题」拉到正确方向（不是只看 1688 中文标题）；
 *  2. 最终类目必须存在于 GLS 类目表（1620 项）里，绝不允许中文/自造字符串；
 *  3. AI 给出的类目如果跟这份证据榜完全不沾边，要被榜首替换（高度匹配兜底）。
 */

import { GLS_CATEGORIES } from '../constants/gls-categories'
import { marketCategoryTexts, pickRelevantCategories, rankRelevantCategories } from '../services/prompts'
import { resolveListingCategories } from '../services/workbench'
import type { Evaluation, SimilarResearch, SourceInfo } from '../types'

const baseSource = (over: Partial<SourceInfo> = {}): SourceInfo =>
  ({
    sourceUrl: 'https://detail.1688.com/offer/123456.html',
    sourceTitle: '定制logo 304不锈钢保温杯 户外便携水杯 礼品杯',
    description: '304不锈钢内胆，真空保温，容量 500ml，适合户外和办公',
    priceCny: 18,
    materialCn: '不锈钢',
    colorsCn: '黑色/白色',
    sizeCn: '25x7cm',
    cartonLCm: 60,
    cartonWCm: 40,
    cartonHCm: 30,
    pcsPerCarton: 30,
    cartonGwKg: 15,
    weightG: 320,
    images: ['https://img.example.com/a.jpg'],
    category: '',
    sourceKeywords: [],
    amazonTitle: '',
    notes: '',
    ...over,
  }) as SourceInfo

const similarWith = (titles: string[]): SimilarResearch => ({
  productType: 'Insulated Stainless Steel Water Bottle',
  amazonItems: [],
  asiItems: titles.map((t) => ({ title: t })),
  suggestions: [],
  amazonSearchTerms: ['insulated water bottle'],
  asiSearchTerms: ['stainless steel bottle'],
})

const inLibrary = (cat: string) => (GLS_CATEGORIES as readonly string[]).includes(cat)

describe('类目选择：市场证据 + 类目表约束', () => {
  it('ASI 同款标题会把候选榜拉向对应的 GLS 类目（Bottles-*）', () => {
    const source = baseSource()
    const withoutEvidence = pickRelevantCategories(source, 40)
    const withEvidence = pickRelevantCategories(source, 40, marketCategoryTexts(similarWith(['Stainless Steel Sport Water Bottle'])))

    expect(withoutEvidence.length).toBeGreaterThan(0)
    // 有市场证据后，Bottles-* 家族必须出现在候选里，且排在很前面
    const bottleIdx = withEvidence.findIndex((c) => c.startsWith('Bottles-'))
    expect(bottleIdx).toBeGreaterThanOrEqual(0)
    expect(bottleIdx).toBeLessThan(15)
    // 所有候选都必须是类目表里的合法字符串
    expect(withEvidence.every(inLibrary)).toBe(true)
  })

  it('rankRelevantCategories 会把主词命中排到前面，且只返回正分项', () => {
    const source = baseSource()
    const ranked = rankRelevantCategories(source, [], 10)
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked[0].score).toBeGreaterThanOrEqual(3)
    expect(ranked.every((r) => r.score > 0)).toBe(true)
    // 保温杯：第一名应是 Bottles-* 或 Mugs & Steins-* 家族
    expect(/^(Bottles|Mugs & Steins)/.test(ranked[0].cat)).toBe(true)
  })

  it('市场证据能把方向纠正到 ASI 同行真正在卖的品类（背包而非水杯）', () => {
    const backpack = baseSource({
      sourceTitle: '定制logo 双肩背包 电脑包 商务通勤',
      description: '涤纶面料，可放 15 寸电脑，多隔层',
      materialCn: '涤纶',
    })
    const similar: SimilarResearch = {
      productType: 'Laptop Backpack',
      amazonItems: [],
      asiItems: [
        { title: 'Business Laptop Backpack with USB Port' },
        { title: 'Promotional Commuter Backpack' },
      ],
      suggestions: [],
      asiSearchTerms: ['promotional backpack', 'laptop backpack'],
    }
    const ranked = rankRelevantCategories(backpack, marketCategoryTexts(similar), 10)
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked.slice(0, 5).some((r) => /BACKPACK/i.test(r.cat))).toBe(true)
  })

  it('ESP 类目分布也参与打分（无同款标题时靠 ASI 自己的归类口径）', () => {
    const source = baseSource()
    const evaluation = {
      marketSnapshot: {
        esp: { categories: [{ name: 'Drinkware', count: 120 }, { name: 'Bottles', count: 80 }] },
      },
    } as unknown as Evaluation
    const texts = marketCategoryTexts(null, evaluation)
    expect(texts.join(' ')).toMatch(/Drinkware/i)
    const ranked = rankRelevantCategories(source, texts, 10)
    expect(ranked.every((r) => inLibrary(r.cat))).toBe(true)
  })

  describe('resolveListingCategories：最终类目判定', () => {
    const source = baseSource()
    const marketTexts = marketCategoryTexts(similarWith(['Stainless Steel Sport Water Bottle']))

    it('AI 选的类目合法且对得上产品和市场证据 → 保留，主类目 = categories[0]', () => {
      const r = resolveListingCategories({
        rawCategories: ['Bottles-Insulated', 'Bottles-Sport Type'],
        rawCategory: 'Bottles-Sport Type',
        source,
        marketTexts,
      })
      expect(r.categories).toContain('Bottles-Insulated')
      expect(r.categories.every(inLibrary)).toBe(true)
      expect(r.primary).toBe(r.categories[0])
    })

    it('AI 编了类目表外的字符串（中文/自造）→ 直接换成类目表里最匹配的，绝不落入非法值', () => {
      const r = resolveListingCategories({
        rawCategories: ['保温杯', 'Stainless Bottles'],
        rawCategory: '保温杯',
        source,
        marketTexts,
      })
      expect(r.categories.length).toBeGreaterThan(0)
      expect(r.categories.every(inLibrary)).toBe(true)
      expect(/^(Bottles|Mugs & Steins)/.test(r.primary)).toBe(true)
    })

    it('AI 选了合法但跟产品完全不沾边的类目（如 Awards）→ 用证据榜榜首替换', () => {
      const r = resolveListingCategories({
        rawCategories: ['Awards-Sports'],
        rawCategory: 'Awards-Sports',
        source,
        marketTexts,
      })
      expect(r.categories.every(inLibrary)).toBe(true)
      expect(/^(Bottles|Mugs & Steins)/.test(r.primary)).toBe(true)
    })
  })
})
