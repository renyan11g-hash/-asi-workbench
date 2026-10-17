export type Verdict = 'GO' | 'MAYBE' | 'NO'

export interface Evaluation {
  score: number
  verdict: Verdict
  summary: string
  pros: string[]
  cons: string[]
  /** 该产品在美国 ASI 市场的弱点清单（中文，给业务侧指出问题点） */
  issues: string[]
  /** 针对每条 issue 的具体改进策略与上架思路（中文） */
  suggestions: string[]
  risks: string[]
  buyers: string[]
  occasions: string[]
  channels: string[]
  asiCategories: string[]
  suggestedThemes?: string[]
  priceAdviceUsd: { min: number; max: number }
  sourcingTips: string
  listingHooks: string[]
  evaluatedAt?: string
}

/** 类似商品市场调研（看图找类似 / ASI & Amazon 关键词建议）持久化结果 */
export interface SimilarItem {
  title: string
  asin?: string
  brand?: string
  priceUsd?: number | null
  url?: string
  note?: string
}

export interface SimilarResearch {
  productType?: string
  visualFeatures?: string[]
  categoryGuess?: string
  amazonItems: SimilarItem[]
  asiItems: SimilarItem[]
  suggestions: string[]
  referenceTitles?: string[]
  priceRangeUsd?: { min?: number | null; max?: number | null }
  generatedAt?: string
}

export interface PriceRow {
  qty: number
  billableKg: number
  unitCostCny: number
  unitCost: number
  unitPrice: number
  margin: number
  shipping: 'air' | 'sea'
  markupRate: number
  code: string
}

export interface ListingQc {
  titleLen: number
  summaryLen: number
  descriptionLen: number
  keywordCount: number
  ok: boolean
  issues: string[]
  /** ilovecargo.com/tool/encode 等价 ASI 标准检测每条规则的通过情况 */
  ilovecargo?: Array<{
    key: string
    label: string
    ok: boolean
    value: number | string
    reason?: string
  }>
}

export interface Listing {
  title: string
  summary: string
  description: string
  keywords: string[]
  category: string
  /** ASI 类目，最多 2 个（从固定 28 项中选） */
  categories?: string[]
  themes: string[]
  /** ASI 标准材质标签（主显示字符串，逗号分隔时表示多材质） */
  material: string
  /** ASI 材质数组（多材质时给前端做 chips） */
  materials?: string[]
  colors: string
  colorChips: string[]
  imprintMethods: string[]
  productSizeInch: string
  /** 产品本身尺寸（cm，L×W×H），用于提交表最右列 */
  productSizeCm?: { l: number; w: number; h: number } | null
  unitWeightLb: number | null
  cartonSizeInch: string
  cartonGwLb: number | null
  priceGrid: PriceRow[]
  packaging: string
  productionTime: string
  imprintArea: string
  warnings: string[]
  titleZh: string
  summaryZh: string
  descriptionZh: string
  keywordsZh: string
  generatedAt?: string
  source?: 'ai' | 'template'
  qc?: ListingQc
}

export interface SourceInfo {
  sourceTitle: string
  sourceUrl: string
  description: string
  sourceKeywords: string[]
  amazonTitle: string
  priceCny: number
  priceMaxCny: number | null
  moq: number
  supplier: string
  materialCn: string
  colorsCn: string
  sizeCn: string
  weightG: number | null
  cartonLCm: number | null
  cartonWCm: number | null
  cartonHCm: number | null
  pcsPerCarton: number | null
  cartonGwKg: number | null
  images: string[]
  category: string
  notes: string
}

export type ProductStatus = 'sourced' | 'listed' | 'archived' | 'trashed'

export interface Product {
  id: string
  /** 关联的选品评估草稿 id（评估库 ↔ 产品库 同步） */
  draftId: string | null
  source: SourceInfo
  evaluation: Evaluation | null
  listing: Listing | null
  /** 市场参考 / 看图找类似 持久化结果 */
  similar: SimilarResearch | null
  status: ProductStatus
  createdAt: string
  updatedAt: string
  /** 进入回收站的时间（status='trashed' 时才有） */
  trashedAt: string | null
}

export interface Settings {
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  fxRate: number
  airRateCnyPerKg: number
  seaRateCnyPerKg: number
  volumetricDivisor: number
  markupAir: number
  markupSea: number
  midStrategy: 'linear' | 'random'
  airQtyLevels: number
  rounding: 'none' | 'cent05' | 'end99'
  qtyLevels: number[]
  /** 档位模式：auto=首档 数量×售价 > $200 自动选 30/50/100 整数档 */
  qtyLevelsMode?: 'auto' | 'manual'
  defaultImprintMethods: string[]
  targetCategories: string[]
}

export const EMPTY_SOURCE: SourceInfo = {
  sourceTitle: '',
  sourceUrl: '',
  description: '',
  sourceKeywords: [],
  amazonTitle: '',
  priceCny: 0,
  priceMaxCny: null,
  moq: 0,
  supplier: '',
  materialCn: '',
  colorsCn: '',
  sizeCn: '',
  weightG: null,
  cartonLCm: null,
  cartonWCm: null,
  cartonHCm: null,
  pcsPerCarton: null,
  cartonGwKg: null,
  images: [],
  category: '',
  notes: '',
}

export const EMPTY_LISTING: Listing = {
  title: '',
  summary: '',
  description: '',
  keywords: [],
  category: '',
  themes: [],
  material: '',
  colors: '',
  colorChips: [],
  imprintMethods: [],
  productSizeInch: '',
  unitWeightLb: null,
  cartonSizeInch: '',
  cartonGwLb: null,
  priceGrid: [],
  packaging: '',
  productionTime: '',
  imprintArea: '',
  warnings: [],
  titleZh: '',
  summaryZh: '',
  descriptionZh: '',
  keywordsZh: '',
}