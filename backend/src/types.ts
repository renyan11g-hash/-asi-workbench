/**
 * 领域模型定义：1688 选品 -> ASI 促销礼品 Listing
 */

export type Verdict = 'GO' | 'MAYBE' | 'NO'

/** ASI/PPAI 选品评估报告（也用于规则引擎兜底） */
export interface Evaluation {
  score: number
  verdict: Verdict
  summary: string
  pros: string[]
  cons: string[]
  /** 弱点清单（中文，给业务侧明确指出问题点） */
  issues: string[]
  /** 可操作的改善建议与策略（中文） */
  suggestions: string[]
  risks: string[]
  buyers: string[]
  occasions: string[]
  channels: string[]
  asiCategories: string[]
  /** AI 推荐的 ASI 主题（评估阶段的初选，不一定作为最终选择） */
  suggestedThemes?: string[]
  priceAdviceUsd: { min: number; max: number }
  sourcingTips: string
  listingHooks: string[]
  evaluatedAt?: string
}

/** 类似商品市场调研（看图找类似 / ASI & Amazon 关键词建议） */
export interface SimilarResearch {
  productType?: string
  visualFeatures?: string[]
  categoryGuess?: string
  /** 亚马逊同类候选（标题 / ASIN / 价格 / 链接） */
  amazonItems: Array<{
    title: string
    asin?: string
    priceUsd?: number | null
    url?: string
    note?: string
  }>
  /** ASI / PPAI / SAGE 分销商同类候选 */
  asiItems: Array<{ title: string; brand?: string; url?: string; note?: string }>
  /** 亚马逊同类商品的搜索流量词（asinseed 风格反查结果） */
  amazonSearchTerms?: string[]
  /** ASI 分销商搜索流量词 */
  asiSearchTerms?: string[]
  /** 高置信度 ASIN 候选（可直接到 asinseed 反查关键词） */
  likelyAsins?: string[]
  /** 竞品品牌（关键词可借用其品牌名组合） */
  competingBrands?: string[]
  /** 给业务侧的关键词、ASIN、上架策略建议 */
  suggestions: string[]
  referenceTitles?: string[]
  priceRangeUsd?: { min?: number | null; max?: number | null }
  generatedAt?: string
}

export interface PriceRow {
  qty: number
  /** 计费重（kg）：max(体积重, 实际毛重) */
  billableKg: number
  unitCostCny: number
  unitCost: number
  unitPrice: number
  /** 固定成本（USD/件）= 商品 + 运费 + 印刷 + 样品摊销（不含杂费） */
  fixedCostUsd: number
  /** 杂费（USD/件）= 售价 × miscFeePct% */
  miscUsd: number
  /** 全口径成本（USD/件）= fixedCostUsd + miscUsd */
  allInCostUsd: number
  /** 毛利润（USD/件）= 售价 − 全口径成本 */
  grossProfit: number
  /** 毛利润（CNY/件）= grossProfit × 实时汇率 */
  grossProfitCny?: number
  /** 总毛利润（USD）= grossProfit × 数量 */
  totalGrossProfitUsd?: number
  /** 总毛利润（CNY）= grossProfitCny × 数量 */
  totalGrossProfitCny?: number
  /** 该档毛利率（0-1） */
  margin: number
  /** 运输方式 */
  shipping: 'air' | 'sea'
  /** 该档售价计算倍率（产品档倍率） */
  markupRate: number
  code: string
}

/** ASI Listing 字段（按平台表单字段一一对应） */
export interface Listing {
  /** Product Title：≤60 字符 */
  title: string
  /** Summary Description：≤130 字符，必须以 "Rush service is available" 结尾 */
  summary: string
  /** Full Description：≤800 字符，50-70% 产品描述 + 30-50% 关键词（融入描述），不出现尺寸 */
  description: string
  /** Keywords：恰好 30 组，每组 ≤30 字符，≤4 单词，Title Case，英文逗号分隔 */
  keywords: string[]
  /** ASI 一级分类（从固定 28 项中选，主显） */
  category: string
  /** Type of Product：ASI 28 个一级大类单选（提交表 E 列） */
  typeOfProduct?: string
  /** ASI 分类（最多 2 个，用于提交表 / 多类目平台） */
  categories?: string[]
  /** 5 个 ASI 主题（必含 Anniversary + Sustainable 作为兜底） */
  themes: string[]
  /** ASI 标准材质标签（逗号分隔多材质） */
  material: string
  /** ASI 标准材质标签数组（多材质，方便前端展示 chips） */
  materials?: string[]
  /** ASI 颜色字符串（"Black/Gray/Brown/Orange/Army Green"） */
  colors: string
  /** ASI 颜色 chips（用于前端编辑） */
  colorChips: string[]
  /** ASI 印刷方式（从固定 17 项中选，可多选） */
  imprintMethods: string[]
  /** 单个产品尺寸（英寸，例 "3.5\" W x 4.7\" H"） */
  productSizeInch: string
  /** 单个产品尺寸（厘米，例 { l: 8, w: 5, h: 12 }），用于「提交表」最右列填入 */
  productSizeCm?: { l: number; w: number; h: number } | null
  /** 单个产品重量（磅） */
  unitWeightLb: number | null
  /** 箱规（英寸） */
  cartonSizeInch: string
  /** 箱规毛重（磅） */
  cartonGwLb: number | null
  /** 6 档报价 */
  priceGrid: PriceRow[]
  /** 英文包装描述 */
  packaging: string
  /** 生产周期 */
  productionTime: string
  /** 印花面积（可选） */
  imprintArea: string
  /** 合规/警告提示 */
  warnings: string[]
  /** 中英对照：中文版标题 */
  titleZh: string
  /** 中英对照：中文版摘要 */
  summaryZh: string
  /** 中英对照：中文版详细描述 */
  descriptionZh: string
  /** 中英对照：中文版关键词（用于人工核查） */
  keywordsZh: string
  generatedAt?: string
  source?: 'ai' | 'template'
  /** 质检报告 */
  qc?: {
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
}

/** 1688 原始商品信息 */
export interface SourceInfo {
  sourceTitle: string
  sourceUrl: string
  /** 1688 详细描述（来自详情页/产品参数） */
  description: string
  /** 1688 关键词（产品页提供的标签，可选） */
  sourceKeywords: string[]
  /** 亚马逊/其他平台同类产品英文标题（用户手动提供的参考） */
  amazonTitle: string
  priceCny: number
  priceMaxCny: number | null
  moq: number
  supplier: string
  materialCn: string
  colorsCn: string
  sizeCn: string
  weightG: number | null
  /** 箱规长宽高（cm） */
  cartonLCm: number | null
  cartonWCm: number | null
  cartonHCm: number | null
  /** 每箱产品数量 */
  pcsPerCarton: number | null
  /** 箱规毛重（kg） */
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
  // AI
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  // 图像生成（默认火山引擎即梦 Seedream 4.0，国内直连；也兼容 OpenAI gpt-image-1）
  /** 图像接口 Base URL（火山 https://ark.cn-beijing.volces.com/api/v3 / OpenAI https://api.openai.com/v1） */
  imageBaseUrl: string
  /** 图像服务 API Key */
  imageApiKey: string
  /** 图像模型（火山 doubao-seedream-4-0-250828 / OpenAI gpt-image-1） */
  imageModel: string
  /** 生成尺寸：火山 1K/2K/4K；OpenAI 1024x1024 / 1536x1024 / 1024x1536 */
  imageSize: string
  /** 生成质量：low / medium / high（OpenAI 专用，火山忽略） */
  imageQuality: 'low' | 'medium' | 'high'
  // 价格模型
  /** 1 USD = ? CNY（默认 6.7，符合用户给定公式） */
  fxRate: number
  /** 汇率自动实时更新（后台定时拉取并覆盖 fxRate），默认开启 */
  fxAutoUpdate: boolean
  /** 空运：元/kg（默认 50） */
  airRateCnyPerKg: number
  /** 海运：元/kg（默认 20） */
  seaRateCnyPerKg: number
  /** 体积重除数：L*W*H / X = kg（默认 5000） */
  volumetricDivisor: number
  /** 利润率：空运首档（默认 1.4） */
  markupAir: number
  /** 利润率：海运末档（默认 1.25） */
  markupSea: number
  /** 中间档策略 */
  midStrategy: 'linear' | 'random'
  /** 取整规则（作用于 ASI 售价） */
  rounding: 'none' | 'cent05' | 'end99'
  /** ASI 阶梯 6C 档位数量（qtyLevelsMode='manual' 时生效） */
  qtyLevels: number[]
  /** 档位模式：auto=按「首档 数量×售价 ≥ $200」自动选 30/50/100 等整数档；manual=手填 qtyLevels */
  qtyLevelsMode: 'auto' | 'manual'
  /** 6 档运输分段：前 N 档空运、后 6-N 档海运（默认 3） */
  airQtyLevels: number
  /** 印刷成本（¥/件，默认 1.5） */
  printCostCny: number
  /** 样品费（¥，整单一次，摊入首档；默认 300） */
  sampleFeeCny: number
  /** 杂费比例（% 售价：手续费 3% + 损耗 1% + 汇率缓冲 1%，默认 5） */
  miscFeePct: number
  // 业务默认
  defaultImprintMethods: string[]
  /** 拼写检查：标题关键词、卖点、默认印花 */
  targetCategories: string[]
}

export const DEFAULT_SETTINGS: Settings = {
  aiBaseUrl: 'https://api.deepseek.com',
  aiApiKey: '',
  aiModel: 'deepseek-chat',
  imageBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  imageApiKey: '',
  imageModel: 'doubao-seedream-4-0-250828',
  imageSize: '2K',
  imageQuality: 'high',
  fxRate: 6.7,
  fxAutoUpdate: true,
  airRateCnyPerKg: 50,
  seaRateCnyPerKg: 20,
  volumetricDivisor: 5000,
  markupAir: 1.4,
  markupSea: 1.25,
  midStrategy: 'linear',
  rounding: 'cent05',
  qtyLevels: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  qtyLevelsMode: 'auto',
  airQtyLevels: 4,
  printCostCny: 1.5,
  sampleFeeCny: 300,
  miscFeePct: 5,
  defaultImprintMethods: ['Silkscreen', 'Laser Engraved'],
  targetCategories: [],
}

// ========== 订单运营中心相关类型 ==========

/** 客户类型 */
export type CustomerType = 'distributor' | 'retailer' | 'corporate' | 'individual'

/** 询盘类型 */
export type InquiryType = 'price_inquiry' | 'custom_quote' | 'sample_request' | 'general_question'

/** 询盘状态 */
export type InquiryStatus = 'new' | 'responded' | 'quoted' | 'converted' | 'closed'

/** 订单状态 */
export type OrderStatus = 'pending' | 'confirmed' | 'production' | 'shipped' | 'delivered' | 'cancelled'

/** 付款状态 */
export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'overdue'

/** 发货状态 */
export type ShipmentStatus = 'pending' | 'shipped' | 'in_transit' | 'delivered'

/** 售后类型 */
export type AfterSaleType = 'quality_issue' | 'shipping_issue' | 'return_request' | 'refund_request'

/** 售后状态 */
export type AfterSaleStatus = 'open' | 'investigating' | 'resolved' | 'closed'

/** 客户信息 */
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

/** 询盘记录 */
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

/** 订单明细 */
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

/** 订单信息 */
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

/** 供应商沟通记录 */
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

/** 邮件草稿 */
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

/** 发货记录 */
export interface Shipment {
  id: string
  orderId: string
  trackingNumber?: string
  carrier?: string
  shippingMethod: 'air' | 'sea'
  status: ShipmentStatus
  estimatedDelivery?: string
  actualDelivery?: string
  notes?: string
  createdAt: string
  updatedAt: string
}

/** 收款记录 */
export interface Payment {
  id: string
  orderId: string
  /** 金额（USD） */
  amount: number
  paymentMethod: string
  paymentDate?: string
  notes?: string
  createdAt: string
}

/** 售后记录 */
export interface AfterSale {
  id: string
  orderId: string
  customerId: string
  type: AfterSaleType
  status: AfterSaleStatus
  description: string
  resolution?: string
  /** 退款金额（USD） */
  refundAmount?: number
  createdAt: string
  updatedAt: string
}

/** 产品图片类型：主图 / 尺寸图 / 介绍图 */
export type ProductImageKind = 'main' | 'dimension' | 'intro'

/** 单张产品图片记录（含生成历史链） */
export interface ProductImage {
  id: string
  productId: string
  /** 图片角色：main=主图（含 Logo+多色缩略图） / dimension=尺寸图（inch） / intro=介绍图 */
  kind: ProductImageKind
  /** 第几张介绍图（1-3），非 intro 为 0 */
  slot: number
  /** 生成该图使用的英文 Prompt（文本模型产出） */
  prompt: string
  /** 用户修改指令历史（对话式改图） */
  history: Array<{ role: 'user' | 'assistant'; content: string; at: string }>
  /** 图片文件名（存于 data/images/{productId}/） */
  file: string
  /** 尺寸图叠加的标注数据（inch），非尺寸图为 null */
  dimensionSpec: {
    /** 宽（正面横向） */
    widthIn: number
    /** 高（正面纵向） */
    heightIn: number
    /** 深/厚（可选） */
    depthIn: number | null
  } | null
  createdAt: string
  updatedAt: string
}