import { buildKeywordTopUpPrompt } from '../services/prompts'
import type { Listing, SimilarResearch, SourceInfo } from '../types'

function source(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    sourceTitle: '304不锈钢保温杯 20oz',
    sourceUrl: 'https://detail.1688.com/offer/123.html',
    description: '材质：304不锈钢，容量：20oz',
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

const used: Partial<Listing> = {
  title: 'Stainless Steel Insulated Tumbler',
  description: 'Double wall tumbler for office commutes.',
  keywords: ['Insulated Tumbler', 'Vacuum Flask'],
  category: 'Bottles-Insulated',
  categories: ['Bottles-Insulated'],
  typeOfProduct: 'Drinkware',
  material: 'Stainless Steel',
  materials: ['Stainless Steel'],
}

const similar: SimilarResearch = {
  asiSearchTerms: ['travel tumbler', 'insulated cup'],
  amazonSearchTerms: ['vacuum insulated tumbler'],
  likelyAsins: [],
  competingBrands: [],
  amazonItems: [],
  referenceTitles: [],
  asiItems: [],
  matched: 0,
  matchTokens: [],
  relevanceNote: '',
  note: '',
  visualCategory: '',
  confidence: '',
} as unknown as SimilarResearch

describe('关键词补词提示词（按同一套 KEYWORD BUILD PROCESS）', () => {
  it('把 6 步流程原样带进提示词', () => {
    const { system } = buildKeywordTopUpPrompt({ source: source(), listing: used, similar, used: used.keywords ?? [], need: 28 })
    expect(system).toContain('KEYWORD BUILD PROCESS (follow this order')
    for (const step of ['1. PRIMARY GOAL', '2. Same-product line', '3. Blend those', '4. A well-known parallel', '5. WORD-LEVEL GLOBAL UNIQUENESS', '6. COVERAGE MATRIX']) {
      expect(system).toContain(step)
    }
    expect(system).toContain('EXACTLY 28 new groups')
  })

  it('告诉 AI 已有组与已占用的单词，禁止复用', () => {
    const { user } = buildKeywordTopUpPrompt({ source: source(), listing: used, similar, used: used.keywords ?? [], need: 28 })
    expect(user).toContain('ALREADY USED GROUPS (2')
    expect(user).toContain('Insulated Tumbler')
    expect(user).toContain('Vacuum Flask')
    expect(user).toContain('USED WORDS')
    expect(user).toContain('tumbler')
    expect(user).toContain('flask')
  })

  it('把看图找类似的市场词当权威流量词来源', () => {
    const { user } = buildKeywordTopUpPrompt({ source: source(), listing: used, similar, used: ['Insulated Tumbler'], need: 1 })
    expect(user).toContain('MARKET RESEARCH TERMS')
    expect(user).toContain('vacuum insulated tumbler')
  })

  it('禁止运输/服务承诺词', () => {
    const { system } = buildKeywordTopUpPrompt({ source: source(), listing: used, used: ['Insulated Tumbler'], need: 1 })
    expect(system).toMatch(/Never mention shipping, freight, sampling, lead time, MOQ, factory-direct/i)
  })
})
