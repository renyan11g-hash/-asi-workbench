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
  /** 亚马逊同类商品的搜索流量词（asinseed 风格反查结果） */
  amazonSearchTerms?: string[]
  /** ASI 分销商搜索流量词 */
  asiSearchTerms?: string[]
  /** 高置信度 ASIN 候选 */
  likelyAsins?: string[]
  /** 竞品品牌 */
  competingBrands?: string[]
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
  /** 固定成本（USD/件）= 商品 + 运费 + 印刷 + 样品摊销（不含杂费） */
  fixedCostUsd?: number
  /** 杂费（USD/件）= 售价 × miscFeePct% */
  miscUsd?: number
  /** 全口径成本（USD/件） */
  allInCostUsd?: number
  /** 毛利润（USD/件） */
  grossProfit?: number
  /** 毛利润（CNY/件）= grossProfit × 实时汇率 */
  grossProfitCny?: number
  /** 总毛利润（USD）= grossProfit × 数量 */
  totalGrossProfitUsd?: number
  /** 总毛利润（CNY）= grossProfitCny × 数量 */
  totalGrossProfitCny?: number
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
  /** Type of Product：ASI 28 个一级大类单选（提交表 E 列） */
  typeOfProduct?: string
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
  /** 印刷成本（¥/件，默认 1.5） */
  printCostCny?: number
  /** 样品费（¥，整单一次，摊入首档；默认 300） */
  sampleFeeCny?: number
  /** 杂费比例（% 售价，默认 5） */
  miscFeePct?: number
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

// ========== 订单运营中心相关类型 ==========

export type CustomerType = 'distributor' | 'retailer' | 'corporate' | 'individual'

export type InquiryType = 'price_inquiry' | 'custom_quote' | 'sample_request' | 'general_question'

export type InquiryStatus = 'new' | 'responded' | 'quoted' | 'converted' | 'closed'

export type OrderStatus = 'pending' | 'confirmed' | 'production' | 'shipped' | 'delivered' | 'cancelled'

export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'overdue'

export interface Customer {
  id: string
  name: string
  company?: string
  email: string
  phone?: string
  address?: string
  country?: string
  type: CustomerType
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface Inquiry {
  id: string
  customerId: string
  subject: string
  content: string
  type: InquiryType
  status: InquiryStatus
  /** 关联的产品ID */
  productId?: string
  /** AI分类结果 */
  aiCategory?: string
  /** AI生成的回复草稿 */
  aiDraft?: string
  createdAt: string
  updatedAt: string
}

export interface OrderItem {
  id: string
  orderId: string
  productId: string
  quantity: number
  /** 单价（USD） */
  unitPrice: number
  /** 小计（USD） */
  totalPrice: number
  /** 印刷规格 */
  imprintSpec?: string
  createdAt: string
}

export interface Order {
  id: string
  customerId: string
  orderNumber: string
  status: OrderStatus
  paymentStatus: PaymentStatus
  /** 订单总金额（USD） */
  totalAmount: number
  /** 定金（USD） */
  depositAmount?: number
  /** 尾款（USD） */
  balanceAmount?: number
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface SupplierCommunication {
  id: string
  productId: string
  supplierName: string
  contactMethod: 'email' | 'phone' | 'wechat' | 'other'
  content: string
  response?: string
  /** 供应商报价（人民币） */
  priceCny?: number
  /** 起订量 */
  moq?: number
  /** 交货周期 */
  leadTime?: string
  createdAt: string
}

export interface EmailDraft {
  id: string
  inquiryId?: string
  customerId: string
  subject: string
  content: string
  isAiGenerated: boolean
  status: 'draft' | 'sent'
  createdAt: string
  updatedAt: string
}

export interface DashboardOverview {
  customers: { total: number }
  inquiries: { total: number; new: number; responded: number; converted: number }
  orders: {
    total: number
    pending: number
    confirmed: number
    production: number
    shipped: number
    unpaid: number
    totalRevenue: number
  }
  products: { total: number }
}

export interface PendingTasks {
  newInquiries: Array<{ inquiryId: string; subject: string; customerName: string; createdAt: string }>
  pendingOrders: Array<{ orderId: string; orderNumber: string; customerName: string; totalAmount: number; createdAt: string }>
  unpaidOrders: Array<{
    orderId: string
    orderNumber: string
    customerName: string
    totalAmount: number
    depositAmount: number | null
    balanceAmount: number | null
    createdAt: string
  }>
}

export interface PriceComparison {
  supplierName: string
  priceCny: number | null
  moq: number | null
  leadTime: string | null
  contactMethod: string
  createdAt: string
}