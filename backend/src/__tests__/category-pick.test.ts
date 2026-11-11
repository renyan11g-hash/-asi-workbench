/**
 * 类目/主题选择质量（用户诉求：类目、类别、主题选错会直接影响曝光）。
 *
 * 三条底线，缺一条就会选错：
 *  1. 候选榜必须被「ASI/Amazon 同款商品的真实标题」拉到正确方向（不是只看 1688 中文标题）；
 *  2. 最终类目必须存在于 GLS 类目表（1620 项）里，绝不允许中文/自造字符串；
 *  3. AI 给出的类目如果跟这份证据榜完全不沾边，要被榜首替换（高度匹配兜底）。
 */

import { GLS_CATEGORIES } from '../constants/gls-categories'
import { espCategoryNames, marketCategoryTexts, pickRelevantCategories, rankRelevantCategories } from '../services/prompts'
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

/** 同时给 Amazon / ASI 两组标题的便捷构造 */
const similarWith2 = (input: { productType: string; asi: string[]; amazon: string[] }): SimilarResearch => ({
  productType: input.productType,
  amazonItems: input.amazon.map((t) => ({ title: t })),
  asiItems: input.asi.map((t) => ({ title: t })),
  suggestions: [],
  amazonSearchTerms: [],
  asiSearchTerms: [],
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

  it('ESP 类目分布只当证据，不参与打分（否则泛匹配的 BAGS 会把鞋类挤下去）', () => {
    // ESP 命中集合是泛匹配：找沙滩拖鞋会连带命中 BAGS/BACKPACKS，不能拿它当类目信号
    const slipper = baseSource({
      sourceTitle: '户外露营速干防滑折叠便携沙滩凉鞋 轻量化溯溪鞋',
      description: 'EVA 鞋底，折叠收纳，速干',
      materialCn: 'EVA,布',
    })
    const similar: SimilarResearch = {
      productType: 'Foldable Travel Slide Slippers',
      amazonItems: [],
      asiItems: [{ title: 'Hotel Amenity Slipper - Bulk Case Packed' }, { title: 'Quick-Dry Water Shoe for Beach' }],
      suggestions: [],
      asiSearchTerms: ['travel slippers'],
    }
    const evaluation = {
      marketSnapshot: {
        esp: {
          categories: [
            { name: 'BAGS', count: 144 },
            { name: 'SHOES', count: 141 },
            { name: 'SLIPPERS', count: 28 },
          ],
        },
      },
    } as unknown as Evaluation

    // 证据文本里不该出现 ESP 的类目名（BAGS 这类泛匹配信号会被挡在打分之外）
    const texts = marketCategoryTexts(similar)
    expect(texts.join(' ')).not.toMatch(/\bBAGS\b/)
    // ESP 类目名单独取，只用于给 AI 看的证据块
    expect(espCategoryNames(evaluation)).toContain('SLIPPERS')

    const ranked = rankRelevantCategories(slipper, texts, 10)
    expect(ranked.every((r) => inLibrary(r.cat))).toBe(true)
    // 正确的鞋类类目必须排在「Bags-Shoe」这种包类前面
    const shoeIdx = ranked.findIndex((r) => /^(SLIPPERS|SHOES|FLIP FLOPS)$/.test(r.cat))
    const bagIdx = ranked.findIndex((r) => r.cat === 'Bags-Shoe')
    expect(shoeIdx).toBeGreaterThanOrEqual(0)
    if (bagIdx >= 0) expect(shoeIdx).toBeLessThan(bagIdx)
  })

  describe('变体选错（家族对、变体不对）', () => {
    it('托特包 → 落在 Tote Bags 家族，而不是 BACKPACKS', () => {
      const tote = baseSource({
        sourceTitle: '东莞厂家定制慵懒风托特包 简约大容量帆布手提包',
        description: '帆布面料，大容量',
        materialCn: '帆布',
      })
      const ranked = rankRelevantCategories(tote, marketCategoryTexts(similarWith2({
        productType: 'Canvas Tote Bag',
        asi: ['Canvas Tote Bag with Gusset - Custom Print'],
        amazon: ['Heavy Duty Canvas Tote Bag with Handles'],
      })), 8)
      expect(ranked[0].cat.startsWith('Tote Bags') || ranked[0].cat === 'TOTE BAGS').toBe(true)
    })

    it('不锈钢啤酒杯 → Mugs & Steins-Metal，不是 -Glass（材质决定变体）', () => {
      const mug = baseSource({
        sourceTitle: '印制LOGO户外304不锈钢啤酒杯野营便携台阶杯',
        description: '304 不锈钢内胆',
        materialCn: '304不锈钢',
      })
      const ranked = rankRelevantCategories(mug, marketCategoryTexts(similarWith2({
        productType: 'Stainless Steel Beer Mug',
        asi: ['Stainless Steel Beer Cup 14 oz - Laser Engraved'],
        amazon: ['Stainless Steel Beer Mug Double Wall'],
      })), 8)
      expect(ranked[0].cat).toBe('Mugs & Steins-Metal')
    })

    it('AI 选了同家族的错变体（-Glass）→ 自动换成更贴合的兄弟变体（-Metal）', () => {
      const mug = baseSource({
        sourceTitle: '印制LOGO户外304不锈钢啤酒杯野营便携台阶杯',
        description: '304 不锈钢',
        materialCn: '304不锈钢',
      })
      const r = resolveListingCategories({
        rawCategories: ['Mugs & Steins-Glass'],
        rawCategory: 'Mugs & Steins-Glass',
        source: mug,
        marketTexts: marketCategoryTexts(similarWith2({
          productType: 'Stainless Steel Beer Mug',
          asi: ['Stainless Steel Beer Cup 14 oz - Laser Engraved'],
          amazon: ['Stainless Steel Beer Mug Double Wall'],
        })),
      })
      expect(r.primary).toBe('Mugs & Steins-Metal')
    })

    it('AI 选了完全不同家族且明显不匹配（Cups-Plastic）→ 换成榜首家族，且不留凑数的第二类目', () => {
      const mug = baseSource({
        sourceTitle: '印制LOGO户外304不锈钢啤酒杯野营便携台阶杯',
        description: '304 不锈钢',
        materialCn: '304不锈钢',
      })
      const r = resolveListingCategories({
        rawCategories: ['Cups-Plastic'],
        rawCategory: 'Cups-Plastic',
        source: mug,
        marketTexts: marketCategoryTexts(similarWith2({
          productType: 'Stainless Steel Beer Mug',
          asi: ['Stainless Steel Beer Cup 14 oz - Laser Engraved'],
          amazon: ['Stainless Steel Beer Mug Double Wall'],
        })),
      })
      expect(r.primary).toBe('Mugs & Steins-Metal')
      expect(r.categories).toEqual(['Mugs & Steins-Metal'])
    })

    it('两个类目同等贴合（拖鞋的 SLIPPERS / SHOES 同分）→ 两个都保留，尊重 AI 顺序', () => {
      const slipper = baseSource({
        sourceTitle: '户外露营速干防滑折叠便携沙滩凉鞋 轻量化溯溪鞋',
        description: 'EVA 鞋底，速干',
        materialCn: 'EVA',
      })
      const r = resolveListingCategories({
        rawCategories: ['SLIPPERS', 'SHOES'],
        rawCategory: 'SLIPPERS',
        source: slipper,
        marketTexts: marketCategoryTexts(similarWith2({
          productType: 'Foldable Travel Slide Slippers',
          asi: ['Hotel Amenity Slipper - Bulk Case Packed'],
          amazon: ['Quick Dry Water Shoes Barefoot Beach Sandals for Camping'],
        })),
      })
      expect(r.primary).toBe('SLIPPERS')
      expect(r.categories.length).toBe(2)
    })
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
