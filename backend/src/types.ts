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
  /** 该档利润率（0-1） */
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
  /** Keywords：≤30 组，每组 ≤30 字符，≤4 单词，Title Case，英文逗号分隔 */
  keywords: string[]
  /** ASI 一级分类（从固定 28 项中选，主显） */
  category: string
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
  // 业务默认
  defaultImprintMethods: string[]
  /** 拼写检查：标题关键词、卖点、默认印花 */
  targetCategories: string[]
}

export const DEFAULT_SETTINGS: Settings = {
  aiBaseUrl: 'https://api.deepseek.com',
  aiApiKey: '',
  aiModel: 'deepseek-chat',
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
  defaultImprintMethods: ['Silkscreen', 'Laser Engraved'],
  targetCategories: [],
}