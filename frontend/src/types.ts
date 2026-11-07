export type Verdict = 'GO' | 'MAYBE' | 'NO'

export interface Evaluation {
  score: number
  /** 分维度打分：差异化 / 定制可行性 / 物流体积 / 市场竞争 / 合规风险（旧数据可能没有） */
  scoreBreakdown?: {
    differentiation: number
    customization: number
    shipping: number
    competition: number
    compliance: number
  }
  /** 总分的由来（哪一维封顶 / 最弱一环），系统生成 */
  scoreNote?: string
  /** 海外市场探测结果（4imprint 真实目录价），评估时抓的 */
  marketSnapshot?: {
    queries: string[]
    total: number
    /** 标题真正命中核心词的同类条数（旧评估没有这个字段） */
    matched?: number
    /** 折算到 28 条口径的密度依据（旧评估没有） */
    densityCount?: number
    /** 判定相关性用的核心词（旧评估没有） */
    matchTokens?: string[]
    priceLow: number | null
    priceHigh: number | null
    median: number | null
    diffEstimate: number
    competitionEstimate: number
    /** 关键词太泛 / 一条都没命中时的提醒（旧评估没有） */
    relevanceNote?: string
    samples: Array<{ title: string; priceMin: number; priceMax: number; url: string }>
    fetchedAt: string
  }
  /** 海外探针失败的原因（成功时为 undefined） */
  marketError?: string
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
  /** AI 建议的印刷方式（已按材质规则引擎过滤并补齐平台必含三项；旧数据没有） */
  suggestedImprintMethods?: string[]
  /** AI 建议的主材质（旧数据没有） */
  suggestedMaterial?: string
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

/** 印刷方式推荐（材质驱动规则引擎的输出） */
export interface ImprintRecommendationItem {
  /** ASI 枚举值（英文，写入 ESP 用这个） */
  method: string
  nameZh: string
  /** 3 首选 / 2 适合 / 1 有条件 / 0 平台必含但本例未必最优 */
  score: number
  tier: 'required' | 'primary' | 'suitable' | 'conditional'
  why: string
  pros: string[]
  cons: string[]
  bestFor: string
  /** 条件/风险提示 */
  caveat?: string
  matchedMaterials: string[]
  required?: boolean
}

export interface ImprintRecommendResult {
  recommendations: ImprintRecommendationItem[]
  /** 明确不适用 + 原因 */
  excluded: Array<{ method: string; nameZh: string; reason: string }>
  materialProfiles: Array<{ name: string; nameZh: string; pros: string[]; cons: string[] }>
  materialTags: string[]
  families: string[]
  summary: string
  materialDetected: boolean
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

export type ProductStatus = 'sourced' | 'listed' | 'archived' | 'trashed' | 'pending_review'

/** 产品图片角色：main=主图（含 Logo 融合）/ dimension=尺寸图（inch 标注）/ intro=介绍图 */
export type ProductImageKind = 'main' | 'dimension' | 'intro'

/** 单张产品图片记录（AI 生成，存于后端 data/images/{productId}/） */
export interface ProductImage {
  id: string
  productId: string
  kind: ProductImageKind
  /** 主图是否融合了品牌 Logo（false=干净产品图） */
  withLogo?: boolean
  /** 第几张介绍图（1-3），非 intro 为 0 */
  slot: number
  /** 生成该图使用的英文 Prompt */
  prompt: string
  history: Array<{ role: 'user' | 'assistant'; content: string; at: string }>
  /** 图片文件名，访问地址：{API_URL}/product-images/{productId}/{file} */
  file: string
  dimensionSpec: {
    widthIn: number
    heightIn: number
    depthIn: number | null
  } | null
  createdAt: string
  updatedAt: string
}

export interface Product {
  id: string
  /** 对外产品编号（RPA0001）：一个产品从录入到上架始终同一个编号 */
  code: string
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
  /** 评分 v2（按市场 list 反算，只读展示；原 evaluation 不动） */
  scoreV2?: number | null
  verdictV2?: 'GO' | 'NEGOTIATE' | 'NO' | null
  marginV2?: number | null
  ceilingCny?: number | null
  scoredAt?: string | null
  /** 审核状态：null/pending 待审；approved 通过；rejected 否决；parked 待询价 */
  reviewState?: 'pending' | 'approved' | 'rejected' | 'parked' | null
  rejectReasons?: string[]
  reviewNote?: string | null
  reviewedAt?: string | null
  /** 来源：manual 手动录入 / auto 自动选品 */
  origin?: 'manual' | 'auto' | null
  /** 自动选品时为什么挑中它 */
  selectionReason?: string | null
  /** 人工核过的市场 list 价（USD） */
  marketListLow?: number | null
  marketListHigh?: number | null
  marketSource?: string | null
  marketCheckedAt?: string | null
}

export interface Settings {
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  /** 产品资料结构化专用模型（留空=沿用 aiModel） */
  aiModelExtract?: string
  /** Listing 质量检查（AI 复检）专用模型（留空=沿用 aiModel） */
  aiModelQc?: string
  // 图像生成（火山引擎 Seedream / OpenAI gpt-image-1）
  imageBaseUrl: string
  imageApiKey: string
  imageModel: string
  imageSize: string
  imageQuality: 'low' | 'medium' | 'high'
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
// ---------------- 批量处理（粘贴多条链接 → 抓取 → 人工补全 → 评估 → 入库） ----------------

export type BatchItemStatus =
  | 'pending'
  | 'fetching'
  | 'fetched'
  | 'evaluating'
  | 'evaluated'
  | 'saving'
  | 'listing'
  /** 英文链接已生成，等人工审核 */
  | 'review'
  | 'done'
  | 'error'
  | 'skipped'

export type BatchJobStatus =
  | 'draft'
  | 'running'
  | 'done'
  | 'paused'
  | 'cancelled'
  | 'interrupted'

/** 整批数据走到哪一站：草稿 → 已抓取待补全 → 已评估 → 已生成链接待审核 → 已入库 */
export type BatchPhase = 'draft' | 'fetched' | 'evaluated' | 'listed' | 'saved'

/** 可单独跑的阶段 */
export type BatchStage = 'fetch' | 'quick' | 'evaluate' | 'listing' | 'save' | 'all'

export interface BatchOptions {
  /** 抓取 1688 详情 */
  fetch: boolean
  /** AI 评估（评分 + 结论 + 海外同款 + 阶梯报价） */
  evaluate: boolean
  /** 保存到产品库 */
  save: boolean
  /** 生成英文 listing */
  listing: boolean
}

export interface BatchItemInput {
  title?: string
  priceCny?: number | null
  moq?: number | null
  sizeCn?: string
  materialCn?: string
  colorsCn?: string
  description?: string
  /** 产品图（可多张）：补全时手动加，或从 1688 一键抓取 */
  images?: string[]
  /** 单件重（克） */
  weightG?: number | null
  /** 箱规长宽高（厘米） */
  cartonLCm?: number | null
  cartonWCm?: number | null
  cartonHCm?: number | null
  /** 每箱装多少个 */
  pcsPerCarton?: number | null
  /** 整箱毛重（公斤） */
  cartonGwKg?: number | null
}

export interface BatchItem {
  idx: number
  url: string
  input: BatchItemInput
  status: BatchItemStatus
  stage: string
  title?: string
  /** 抓取 + 手填合并后的完整资料（补全表单的初值） */
  source?: SourceInfo | null
  /** 还缺哪些字段（箱规这类 1688 抓不到的） */
  missing?: string[]
  evaluated?: boolean
  /** 只跑过「选品预估」（缺字段按默认值估算），还没做正式评估 */
  quickEvaluated?: boolean
  warn?: string
  error?: string
  score?: number | null
  verdict?: string | null
  marketNote?: string | null
  productId?: string | null
  /** 英文链接待审核记录的 id（审核通过后才有 productId） */
  reviewId?: string | null
  /** 从产品档案载入的条目：指向产品库里那条已有档案（生成链接不新建产品） */
  recordId?: string | null
  fetchedFields?: string[]
  updatedAt?: string
}

export interface BatchJob {
  id: string
  status: BatchJobStatus
  phase: BatchPhase
  options: BatchOptions
  items: BatchItem[]
  note: string
  /** 上一次跑的阶段：暂停后「继续」按它接着跑 */
  lastStage?: BatchStage | ''
  createdAt: string
  updatedAt: string
}

export interface BatchParseRow {
  url: string
  input: BatchItemInput
}

export interface BatchParseResult {
  ok: boolean
  rows: BatchParseRow[]
  issues: Array<{ line: number; text: string; error: string }>
  duplicates: string[]
  manualCount: number
  maxItems: number
  willProcess: number
}

export interface BatchJobSummary {
  id: string
  status: BatchJobStatus
  phase: BatchPhase
  note: string
  total: number
  /** 已抓取资料的条数 */
  fetched: number
  /** 已评估的条数 */
  evaluated: number
  /** 已入库的条数 */
  done: number
  failed: number
  /** 还缺关键字段的条数 */
  missing: number
  createdAt: string
  updatedAt: string
}

// ---------------- 产品资料库（自建主数据：录一次，抓取时自动命中） ----------------

export interface MasterProduct {
  id: string
  offerId: string | null
  sourceUrl: string
  title: string
  priceCny: number | null
  sizeCn: string
  weightG: number | null
  cartonLCm: number | null
  cartonWCm: number | null
  cartonHCm: number | null
  pcsPerCarton: number | null
  cartonGwKg: number | null
  /** 多张产品图（出图时作为参考图） */
  images: string[]
  notes: string
  supplier: string
  materialCn: string
  colorsCn: string
  createdAt: string
  updatedAt: string
  /** 已建进产品流水线时的产品档案信息（导入即建档） */
  productId?: string | null
  productCode?: string | null
  productStatus?: string | null
}

// ---------------- 英文链接待审核库（批量生成的 listing 先在这里审核，通过才进产品库） ----------------

export type ReviewStatus = 'pending' | 'approved' | 'rejected'

/** 列表用的轻量记录 */
export interface ListingReviewSummary {
  id: string
  batchJobId: string | null
  batchIdx: number | null
  /** 批量生产任务 id / 条目序号（staged 模式才有） */
  jobId?: string | null
  itemIdx?: number | null
  /** inline=旧流程（生成即写产品）；staged=批量生产（通过后才写产品） */
  mode?: 'inline' | 'staged'
  /** 程序规则质量检查报告 */
  qc?: ListingQcReport | null
  title: string
  sourceUrl: string
  image: string | null
  score: number | null
  verdict: string | null
  status: ReviewStatus
  productId: string | null
  reviewNote: string | null
  /** 人工编辑过内容的时间 */
  editedAt?: string | null
  createdAt: string
  updatedAt: string
}

/** 详情：审核时看的全量内容 */
export interface ListingReview extends ListingReviewSummary {
  source: SourceInfo
  evaluation: Evaluation | null
  listing: Listing
  /** 生成草稿前产品上原来的 Listing（通过后会替换，这里留一份备查） */
  prevListing?: Listing | null
  priceGrid: PriceRow[]
}

// ---------------- 产品流水线（统一产品档案） ----------------

/** 下一步该做什么（流水线上每行的「一键到下一步」按钮） */
export type FlowNextStep =
  | 'specs'
  | 'evaluate'
  /** 评估跑完，等人工定通过/待定 */
  | 'evalReview'
  /** 评估没通过（待定） */
  | 'parked'
  | 'listing'
  | 'review'
  | 'confirm'
  | 'done'
  | 'rejected'
  | 'trashed'

/** 流水线一行：一个产品一条档案，每一步做到哪都在这 */
export interface FlowRow {
  id: string
  code: string
  /** 中文原名（1688 抓到的） */
  title: string
  /** 英文标题（已生成文案才有） */
  titleEn: string
  sourceUrl: string
  status: ProductStatus
  score: number | null
  verdict: string | null
  reviewNote: string
  updatedAt: string
  specs: {
    missing: string[]
    complete: boolean
    /** 会影响评分可信度的关键字段 */
    criticalMissing: string[]
  }
  hasEval: boolean
  hasListing: boolean
  images: { ai: number; source: boolean; thumb: string; thumbFallback: string }
  nextStep: FlowNextStep
  /** 评估人工审核结果：pending 待审 / approved 通过 / rejected 待定 */
  evalReview?: 'pending' | 'approved' | 'rejected' | null
  /** pipeline=流水线 / pre=预产品库 / rpa=RPA 档案库 */
  libraryState?: string
  glsCode?: string | null
  prevCode?: string | null
}

/** 总览漏斗计数 */
export interface FlowOverview {
  total: number
  needSpecs: number
  needEval: number
  /** 评估跑完等人工定通过/待定 */
  needEvalReview?: number
  /** 评估没通过（待定） */
  parked?: number
  needListing: number
  pendingReview: number
  needConfirm: number
  listed: number
  /** 预产品库（已发 GLS 号） */
  inPreLibrary?: number
  /** RPA 档案库 */
  inRpaArchive?: number
  archived: number
  withImages: number
  updatedAt: string
}

// ---------------- 预产品库 / RPA 档案库 / 评估库（2026-11-07 流程合并） ----------------

export interface LibraryRow {
  id: string
  code: string
  glsCode: string | null
  prevCode: string | null
  libraryState: string
  status: string
  title: string
  sourceUrl: string
  score: number | null
  verdict: string | null
  evalReview: 'pending' | 'approved' | 'rejected' | null
  reviewState: string | null
  hasListing: boolean
  updatedAt: string
  rpaArchivedAt: string | null
}

export interface EvaluationRow extends LibraryRow {
  /** 没有关联产品时为空（改版前的老草稿） */
  productId: string | null
  orphan: boolean
  evalSummary: string
  evalScore: number | null
  evalVerdict: string | null
  evalReviewedAt: string | null
  draftId: string | null
  evalPros: string[]
  evalCons: string[]
  evalSuggestions: string[]
  evalBuyers: string[]
  evalIssues: string[]
  evalScoreNote: string
}

// ---------------- 批量生产系统 V1：产品结构化资料 ----------------

export interface ProductSpecs {
  productName: string
  material: string
  productSize: string
  productWeight: string
  colors: string
  specifications: string
  functions: string
  features: string
  logoCustomization: string
  packaging: string
  cartonDimensions: string
  unitsPerCarton: string
  cartonGrossWeight: string
  application: string
}

export interface SpecFieldDef {
  key: keyof ProductSpecs
  label: string
  labelEn: string
  hint: string
}

export interface ProductSpecRecord {
  productId: string
  specs: ProductSpecs
  unknownFields: string[]
  filled: number
  total: number
  model: string
  sourceHash?: string
  extractedAt: string | null
  editedAt: string | null
  updatedAt: string
}

/** 产品信息卡（资料卡页与批量生产中心共用） */
export interface ProductCard {
  productId: string
  code: string
  title: string
  category: string
  status: ProductStatus
  hasListing: boolean
  updatedAt: string
  thumb: string
  thumbFallback: string
  /** 还有没审的批量草稿：再生成会替换掉它（edited=草稿被人改过） */
  pendingDraft?: {
    count: number
    edited: boolean
  }
  specs: {
    filled: number
    total: number
    unknownFields: string[]
    extractedAt: string | null
    editedAt: string | null
    stale: boolean
  }
}

export interface ProductSpecDetail {
  productId: string
  code: string
  title: string
  sourceUrl: string
  status: ProductStatus
  category: string
  hasListing: boolean
  record: ProductSpecRecord
  stale: boolean
  source: {
    title: string
    description: string
    materialCn: string
    colorsCn: string
    sizeCn: string
    weightG: number | null
    carton: [number | null, number | null, number | null]
    pcsPerCarton: number | null
    cartonGwKg: number | null
    notes: string
  }
  fields: SpecFieldDef[]
}

// ---------------- 批量生产系统 V1：任务与质量检查 ----------------

export type QcLevel = 'error' | 'warn'

export interface QcCheck {
  key: string
  label: string
  ok: boolean
  level: QcLevel
  detail: string
}

export interface ListingQcReport {
  ok: boolean
  checks: QcCheck[]
  unsupported: string[]
  needsAi: boolean
  aiChecked: boolean
  aiFindings: string[]
  checkedAt: string
}

export type ProductionJobKind = 'listing' | 'spec'
export type ProductionJobStatus = 'queued' | 'running' | 'paused' | 'done' | 'cancelled' | 'interrupted'
export type ProductionItemStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled'

export interface ProductionItem {
  idx: number
  productId: string
  code: string
  title: string
  status: ProductionItemStatus
  stage: string
  reviewId?: string | null
  qcOk?: boolean | null
  qcIssues?: string[]
  filled?: number | null
  error?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
}

export interface ProductionJob {
  id: string
  kind: ProductionJobKind
  status: ProductionJobStatus
  items: ProductionItem[]
  note: string
  createdAt: string
  updatedAt: string
}

export interface ProductionProgress {
  total: number
  done: number
  failed: number
  cancelled: number
  pending: number
  percent: number
  current: string
}

export interface AiCallLog {
  id: number
  task: string
  productId: string | null
  model: string
  baseUrl: string
  durationMs: number
  promptTokens: number | null
  completionTokens: number | null
  ok: boolean
  error: string | null
  createdAt: string
}

export interface AiCallSummary {
  task: string
  calls: number
  failed: number
  avgMs: number
  promptTokens: number
  completionTokens: number
}
