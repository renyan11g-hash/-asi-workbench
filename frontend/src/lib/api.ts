import apiClient, { getErrorMessage } from './api-client'
import {
  AiCallLog,
  AiCallSummary,
  BatchItemInput,
  BatchJob,
  BatchJobSummary,
  BatchOptions,
  BatchParseResult,
  Customer,
  CustomerType,
  DashboardOverview,
  EmailDraft,
  Evaluation,
  FlowOverview,
  FlowRow,
  EvaluationRow,
  ImprintRecommendResult,
  LibraryRow,
  Inquiry,
  InquiryStatus,
  Listing,
  ListingQcReport,
  ListingReview,
  ListingReviewSummary,
  MasterProduct,
  Order,
  OrderItem,
  OrderStatus,
  PaymentStatus,
  PendingTasks,
  PriceComparison,
  PriceRow,
  Product,
  ProductCard,
  ProductImage,
  ProductSpecDetail,
  ProductSpecRecord,
  ProductSpecs,
  ProductStatus,
  ProductionJob,
  ProductionProgress,
  Settings,
  SimilarResearch,
  SourceInfo,
  SpecFieldDef,
  SupplierCommunication,
} from '../types'

/** AI 生成类接口耗时较长：默认 10 分钟，需与后端 AI_TIMEOUT_MS 保持一致 */
const LONG_TIMEOUT = { timeout: 600_000 }

export { getErrorMessage }

export interface SettingsResponse {
  settings: Settings
  hasApiKey: boolean
  hasImageApiKey?: boolean
}

export interface AiProviderPreset {
  id: string
  name: string
  kind: 'text' | 'image'
  baseUrl: string
  models: string[]
  keyUrl: string
  needsProxy: boolean
  supportsVision: boolean
  priceNote: string
  note: string
}

export interface SourcingHistoryItem {
  id: string
  url: string
  title: string
  score: number | null
  verdict: string | null
  source: Partial<SourceInfo>
  fetched: Record<string, unknown>
  evaluation: Evaluation
  priceGrid: PriceRow[]
  createdAt: string
  updatedAt: string
}

export const api = {
  async getSettings(): Promise<SettingsResponse> {
    const { data } = await apiClient.get<SettingsResponse>('/settings')
    return data
  },

  async saveSettings(patch: Partial<Settings>): Promise<SettingsResponse> {
    const { data } = await apiClient.put<SettingsResponse>('/settings', patch)
    return data
  },

  async testConnection(probe: Partial<Settings>): Promise<{ ok: boolean; message: string }> {
    const { data } = await apiClient.post<{ ok: boolean; message: string }>(
      '/settings/test',
      probe,
      LONG_TIMEOUT
    )
    return data
  },

  /** 图像服务连通性测试（真实生成一张小图验证） */
  async testImageConnection(
    probe: Partial<Pick<Settings, 'imageBaseUrl' | 'imageApiKey' | 'imageModel'>>
  ): Promise<{ ok: boolean; message: string }> {
    const { data } = await apiClient.post<{ ok: boolean; message: string }>(
      '/product-images/test',
      probe,
      LONG_TIMEOUT
    )
    return data
  },

  async listProducts(params?: { status?: string; q?: string }): Promise<Product[]> {
    const { data } = await apiClient.get<{ products: Product[] }>('/products', { params })
    return data.products
  },

  async getProduct(id: string): Promise<Product> {
    const { data } = await apiClient.get<{ product: Product }>(`/products/${id}`)
    return data.product
  },

  /** 全量重算评分 v2（只写 score_v2 等新列，不动原评分） */
  async rescoreAll(): Promise<{ updated: number; counts: Record<string, number> }> {
    const { data } = await apiClient.post<{ updated: number; counts: Record<string, number> }>(
      '/products/rescore-all'
    )
    return data
  },

  /** 单条重算评分 v2 */
  async rescoreOne(id: string): Promise<Product> {
    await apiClient.post(`/products/${id}/rescore`)
    return api.getProduct(id)
  },

  /** 单条审核 */
  async reviewProduct(
    id: string,
    payload: { state: 'pending' | 'approved' | 'rejected' | 'parked'; reasons?: string[]; note?: string }
  ): Promise<Product> {
    const { data } = await apiClient.post<{ product: Product }>(`/products/${id}/review`, payload)
    return data.product
  },

  /** 批量审核 */
  async reviewBulk(
    ids: string[],
    payload: { state: 'pending' | 'approved' | 'rejected' | 'parked'; reasons?: string[]; note?: string }
  ): Promise<{ updated: number }> {
    const { data } = await apiClient.post<{ updated: number }>('/products/review-bulk', { ids, ...payload })
    return data
  },

  /** 人工核市场价（ESP 同款 list 价），保存后自动重算 v2 */
  async setMarketPrice(id: string, low: number, high: number, source = 'ESP'): Promise<Product> {
    const { data } = await apiClient.post<{ product: Product }>(`/products/${id}/market-price`, { low, high, source })
    return data.product
  },

  /** 触发一次自动选品（prompt 为空则用内置品类池） */
  async runDailySourcing(payload: { prompt?: string; limit?: number }): Promise<{
    ok: boolean
    keywords: string[]
    keywordSource: string
    scanned: number
    candidates: number
    created: Array<{ id: string; title: string; priceCny: number | null; score: number | null; reason: string }>
    skipped: Array<{ url: string; reason: string }>
  }> {
    const { data } = await apiClient.post('/products/sourcing/daily', payload, { timeout: 600000 })
    return data as any
  },

  async createProduct(payload: {
    source: SourceInfo
    evaluation?: Evaluation | null
    listing?: Listing | null
    /** 看图找类似 / 市场调研结果（关键词生成会自动注入） */
    similar?: SimilarResearch | Record<string, unknown> | null
    status?: ProductStatus
    /** 关联的评估草稿 id：同一草稿重复保存时更新已关联产品，避免重复建品 */
    draftId?: string | null
  }): Promise<Product> {
    const { data } = await apiClient.post<{ product: Product }>('/products', payload)
    return data.product
  },

  async updateProduct(
    id: string,
    patch: {
      source?: Partial<SourceInfo>
      evaluation?: Evaluation | null
      listing?: Listing | null
      status?: ProductStatus
    }
  ): Promise<Product> {
    const { data } = await apiClient.patch<{ product: Product }>(`/products/${id}`, patch)
    return data.product
  },

  /** 更新源信息（链接生成页编辑）：后端联动重算 listing 派生字段并同步评估库草稿 */
  async updateProductSource(
    id: string,
    source: Partial<SourceInfo>
  ): Promise<{ product: Product; syncedDraftId: string | null }> {
    const { data } = await apiClient.patch<{ product: Product; syncedDraftId: string | null }>(
      `/products/${id}/source`,
      { source }
    )
    return data
  },

  async deleteProduct(id: string): Promise<{ action: string }> {
    const { data } = await apiClient.delete<{ action: string }>(`/products/${id}`)
    return data
  },

  async restoreProduct(id: string): Promise<Product> {
    const { data } = await apiClient.post<{ product: Product }>(`/products/${id}/restore`, {})
    return data.product
  },

  async purgeProduct(id: string): Promise<void> {
    await apiClient.delete(`/products/${id}/purge`)
  },

  async clearProducts(scope: 'active' | 'trashed' | 'all'): Promise<{ deleted: number; scope: string; message: string }> {
    const { data } = await apiClient.delete<{ deleted: number; scope: string; message: string }>('/settings/data', {
      params: { scope },
    })
    return data
  },

  async recycleBinStats(): Promise<{ trashedCount: number }> {
    const { data } = await apiClient.get<{ trashedCount: number }>('/products/recycle-bin/stats')
    return data
  },

  async previewEvaluate(
    source: SourceInfo,
    /** 「看图找类似」已算出的英文词：传上去后端就不用再翻一遍，海外同款抓得更准 */
    searchTerms?: string[],
    /** 「看图找类似」认出的英文品类名，后端用它判断"搜到的算不算同款" */
    productType?: string
  ): Promise<{ evaluation: Evaluation; priceGrid: PriceRow[] }> {
    const { data } = await apiClient.post<{ evaluation: Evaluation; priceGrid: PriceRow[] }>(
      '/products/preview/evaluate',
      { source, searchTerms, productType },
      LONG_TIMEOUT
    )
    return data
  },

  async previewListing(
    source: SourceInfo,
    answers?: Array<{ id: string; question: string; answer: string }>,
    similar?: SimilarResearch | Record<string, unknown> | null,
    evaluation?: Evaluation | Record<string, unknown> | null
  ): Promise<Listing> {
    const { data } = await apiClient.post<{ listing: Listing }>(
      '/products/preview/listing',
      { source, answers, similar, evaluation },
      LONG_TIMEOUT
    )
    return data.listing
  },

  async previewListingQuestions(
    source: SourceInfo
  ): Promise<{ questions: Array<{ id: string; question: string; placeholder: string; hint?: string }>; fallback?: boolean; message?: string }> {
    const { data } = await apiClient.post<{
      questions: Array<{ id: string; question: string; placeholder: string; hint?: string }>
      fallback?: boolean
      message?: string
    }>('/products/preview/listing-questions', { source }, LONG_TIMEOUT)
    return data
  },

  async previewFindSimilar(source: SourceInfo): Promise<{ similar: Record<string, unknown> }> {
    const { data } = await apiClient.post<{ similar: Record<string, unknown> }>(
      '/products/preview/find-similar',
      { source },
      LONG_TIMEOUT
    )
    return data
  },

  async fetch1688(url: string): Promise<{
    ok: boolean
    message: string
    fromMaster?: boolean
    fetched: Partial<{
      sourceTitle: string
      sourceKeywords: string[]
      description: string
      materialCn: string
      colorsCn: string
      sizeCn: string
      weightG: number | null
      cartonSpecCm: string
      pcsPerCarton: number | null
      cartonGwKg: number | null
      moq: number | null
      priceCny: number | null
      image: string
      images: string[]
    }>
  }> {
    const { data } = await apiClient.post('/products/preview/fetch-1688', { url }, LONG_TIMEOUT)
    return data
  },

  /** 粘贴 1688 链接 → 抓取（多通道反爬兜底）+ AI 评估一条龙（选品预估页快速评估用） */
  async quickEvaluate(url: string): Promise<{
    ok: boolean
    message: string
    fetched: {
      sourceTitle: string
      sourceKeywords: string[]
      description: string
      materialCn: string
      colorsCn: string
      sizeCn: string
      weightG: number | null
      cartonSpecCm: string
      pcsPerCarton: number | null
      cartonGwKg: number | null
      moq: number | null
      priceCny: number | null
    }
    source: SourceInfo
    evaluation: Evaluation
    priceGrid: PriceRow[]
  }> {
    const { data } = await apiClient.post('/products/preview/quick-evaluate', { url }, LONG_TIMEOUT)
    return data
  },

  /** 历史选品：快速评估记录列表（按更新时间倒序） */
  async listSourcingHistory(): Promise<{ items: SourcingHistoryItem[] }> {
    const { data } = await apiClient.get<{ items: SourcingHistoryItem[] }>('/sourcing-history')
    return data
  },

  /** 删除一条历史选品记录 */
  async deleteSourcingHistory(id: string): Promise<{ ok: boolean }> {
    const { data } = await apiClient.delete<{ ok: boolean }>(`/sourcing-history/${id}`)
    return data
  },

  async refreshFxRate(refresh = false): Promise<{
    ok: boolean
    fxRate: number
    source?: string
    updatedAt?: string
    autoUpdate?: boolean
    message?: string
  }> {
    const { data } = await apiClient.get<{
      ok: boolean
      fxRate: number
      source?: string
      updatedAt?: string
      autoUpdate?: boolean
      message?: string
    }>('/settings/fx-rate', { params: refresh ? { refresh: '1' } : undefined })
    return data
  },

  async listAiProviders(): Promise<{ providers: AiProviderPreset[] }> {
    const { data } = await apiClient.get('/settings/ai-providers')
    return data
  },

  // ---------- 印刷方式推荐（本地规则引擎，无需 AI） ----------
  async imprintRecommend(source: SourceInfo): Promise<ImprintRecommendResult> {
    const { data } = await apiClient.post('/products/imprint-recommend', { source })
    return data
  },

  // ---------- AI 助手对话窗口（免提问，自动补全信息） ----------
  async assistantChat(payload: {
    source?: SourceInfo
    listing?: Partial<Listing> | null
    /** 分区对话模式：限制 AI 只能讨论/修改这些字段 */
    fields?: string[]
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  }): Promise<{ reply: string; patch: Record<string, unknown> | null; notes: string[] }> {
    const { data } = await apiClient.post('/products/assistant', payload, LONG_TIMEOUT)
    return data
  },

  // ---------- 分块重新生成（只重生成指定区块字段，不重生成整个 listing） ----------
  async regenerateFields(
    id: string,
    fields: string[],
    instruction?: string
  ): Promise<{ values: Record<string, unknown>; listing: Listing | null }> {
    const { data } = await apiClient.post(
      `/products/${id}/regenerate-fields`,
      { fields, instruction: instruction?.trim() || undefined },
      LONG_TIMEOUT
    )
    return data
  },

  // ---------- 1688 选品自动搜寻（AI 推荐选品方向 + 1688 搜索词） ----------
  async sourcingSuggest(payload: {
    category?: string
    keywords?: string
    budgetCny?: number
    targetPriceUsd?: number
    notes?: string
  }): Promise<{
    directions: Array<{
      product: string
      why: string
      search1688: string[]
      category: string
      expectedUnitCostCny: number | null
      expectedSellUsd: { min: number; max: number } | null
      risks: string[]
    }>
    keywords1688: string[]
    tips: string[]
  }> {
    const { data } = await apiClient.post('/products/sourcing-suggest', payload, LONG_TIMEOUT)
    return data
  },

  // ---------- 深度选品研究（对标 4imprint 热销 → AI 分析 → 1688 找同款） ----------
  async sourcingResearch(payload: {
    category?: string
    keywords?: string
    budgetCny?: number
    notes?: string
  }): Promise<{
    ok: boolean
    query: string
    queryEn: string
    asiProducts: Array<{
      name: string
      url: string
      image: string
      priceFrom: number | null
      priceTo: number | null
      rating: number | null
      category: string
      orderMin: string
      shipDays: string
    }>
    directions: Array<{
      asiProduct: { name: string; url: string }
      why: string
      features: string[]
      search1688: string[]
      /** 后端用 GBK 编码生成的可打开 1688 搜索链接（与 search1688 一一对应） */
      search1688Urls?: string[]
      expectedUnitCostCny: number | null
      expectedSellUsd: { min: number; max: number } | null
      risks: string[]
      matches: Array<{ url: string; title: string; priceCny: number | null; image: string; moq: number | null }>
    }>
    tips: string[]
  }> {
    const { data } = await apiClient.post('/products/sourcing-research', payload, LONG_TIMEOUT)
    return data
  },

  // ---------- 服务端草稿（选品评估防丢失） ----------
  async listDrafts(): Promise<
    Array<{ id: string; title: string; createdAt: string; updatedAt: string }>
  > {
    const { data } = await apiClient.get('/drafts')
    return data.drafts
  },

  async saveDraft(payload: {
    id?: string
    title?: string
    content?: Record<string, unknown>
  }): Promise<{ draft: { id: string; title: string; updatedAt: string } }> {
    const { data } = await apiClient.post('/drafts', payload)
    return data
  },

  async getDraft(id: string): Promise<{
    draft: { id: string; title: string; content: Record<string, unknown>; createdAt: string; updatedAt: string }
  }> {
    const { data } = await apiClient.get(`/drafts/${id}`)
    return data
  },

  async deleteDraft(id: string): Promise<void> {
    await apiClient.delete(`/drafts/${id}`)
  },

  async evaluateProduct(id: string): Promise<Product> {
    const { data } = await apiClient.post<{ product: Product }>(
      `/products/${id}/evaluate`,
      {},
      LONG_TIMEOUT
    )
    return data.product
  },

  async chatEvaluation(
    id: string,
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  ): Promise<Product> {
    const { data } = await apiClient.post<{ product: Product }>(
      `/products/${id}/chat-evaluation`,
      { messages },
      LONG_TIMEOUT
    )
    return data.product
  },

  async previewChatEvaluation(
    source: SourceInfo,
    evaluation: Evaluation,
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  ): Promise<{ evaluation: Evaluation; assistantReply: string }> {
    const { data } = await apiClient.post<{ evaluation: Evaluation; assistantReply: string }>(
      '/products/preview/chat-evaluation',
      { source, evaluation, messages },
      LONG_TIMEOUT
    )
    return data
  },

  /**
   * 异步生成 Listing：POST 立即返回 taskId，然后轮询 GET /products/tasks/:taskId。
   * 解决 Render 免费层 100 秒代理超时导致的 502（同步等待 AI 生成 1-5 分钟必挂）。
   */
  async generateProductListing(
    id: string,
    answers?: Array<{ id: string; question: string; answer: string }>,
    onProgress?: (elapsedSec: number) => void
  ): Promise<Product> {
    const { data: start } = await apiClient.post<{ taskId: string; status: string }>(
      `/products/${id}/listing`,
      answers ? { answers } : {}
    )
    const taskId = start.taskId
    if (!taskId) throw new Error('后端未返回 taskId，请检查后端版本')

    const startedAt = Date.now()
    const MAX_WAIT_MS = 10 * 60 * 1000 // 与后端 AI 超时一致
    const POLL_INTERVAL_MS = 3000

    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const elapsed = Date.now() - startedAt
      onProgress?.(Math.round(elapsed / 1000))
      if (elapsed > MAX_WAIT_MS) {
        throw new Error('生成超时（超过 10 分钟），请重试或检查 AI 服务商状态')
      }
      let task: { status: string; result?: { productId?: string }; error?: string; hint?: string }
      try {
        const { data } = await apiClient.get<{ status: string; result?: { productId?: string }; error?: string; hint?: string }>(
          `/products/tasks/${taskId}`
        )
        task = data
      } catch (err) {
        // 404 = 任务不存在（服务重启清空）；其他网络抖动继续轮询
        const msg = err instanceof Error ? err.message : String(err)
        if (/404|不存在/.test(msg)) throw new Error('任务已丢失（服务可能重启过），请重新生成')
        continue
      }
      if (task.status === 'done') {
        const { data } = await apiClient.get<{ product: Product }>(`/products/${id}`)
        return data.product
      }
      if (task.status === 'error') {
        throw new Error(task.error ? `${task.error}${task.hint ? `（${task.hint}）` : ''}` : '生成失败，请重试')
      }
      // pending / running → 继续轮询
    }
  },

  async findSimilarForProduct(id: string): Promise<{ similar: SimilarResearch; product: Product }> {
    const { data } = await apiClient.post<{ similar: SimilarResearch; product: Product }>(
      `/products/${id}/find-similar`,
      {},
      LONG_TIMEOUT
    )
    return data
  },

  /** 重算阶梯报价：可传入人工指定的计费重 / 倍率 */
  async reprice(
    id: string,
    overrides?: {
      billableKg?: number | null
      markupAir?: number | null
      markupSea?: number | null
      shippingModes?: Array<'air' | 'sea' | null>
      /** 只切换某一档运输方式（其它档价格保持不变） */
      toggle?: { idx: number; mode: 'air' | 'sea' }
    }
  ): Promise<Product> {
    const { data } = await apiClient.post<{ product: Product }>(
      `/products/${id}/reprice`,
      overrides ?? {},
      LONG_TIMEOUT
    )
    return data.product
  },

  /** 每种图的出图计划（参考哪些产品图 + 哪种风格参考图 + 生成前对话） */
  async getImagePlan(productId: string): Promise<{
    plan: Record<
      string,
      {
        sources: string[]
        refs: string[]
        notes: string
        chat: Array<{ role: 'user' | 'assistant'; content: string; at: string }>
      }
    >
  }> {
    const { data } = await apiClient.get(`/product-images/product/${productId}/plan`)
    return data
  },

  async saveImagePlan(
    productId: string,
    payload: {
      kind: 'main' | 'dimension' | 'detail' | 'scene'
      sources?: string[]
      /** 这张图额外参考的「风格参考图」（只学构图/光线/场景，不改产品） */
      refs?: string[]
      notes?: string
      chat?: Array<{ role: 'user' | 'assistant'; content: string; at?: string }>
    }
  ): Promise<{
    plan: Record<string, { sources: string[]; refs: string[]; notes: string; chat: unknown[] }>
  }> {
    const { data } = await apiClient.put(`/product-images/product/${productId}/plan`, payload)
    return data
  },

  /** 生成前先和 AI 对话：确认这张图怎么拍，AI 会给一段生成注意点 */
  /** AI 自动挑图：认每张产品图是正面/侧面对比/特写/场景，再按用途分配参考图 */
  async autoAssignImagePlan(productId: string): Promise<{
    picks: { main: string[]; dimension: string[]; detail: string[]; scene: string[] }
    roles: Array<{ index?: number; role?: string; reason?: string }>
    count: number
    plan: Record<
      string,
      {
        sources: string[]
        refs: string[]
        notes: string
        chat: Array<{ role: 'user' | 'assistant'; content: string; at: string }>
      }
    >
  }> {
    const { data } = await apiClient.post(`/product-images/product/${productId}/plan/auto`, {}, LONG_TIMEOUT)
    return data
  },

  async chatImagePlan(
    productId: string,
    payload: {
      kind: 'main' | 'dimension' | 'detail' | 'scene'
      message: string
      messages?: Array<{ role: 'user' | 'assistant'; content: string }>
    }
  ): Promise<{
    reply: string
    notes: string
    plan: Record<string, { sources: string[]; refs: string[]; notes: string }>
  }> {
    const { data } = await apiClient.post(`/product-images/product/${productId}/plan/chat`, payload, LONG_TIMEOUT)
    return data
  },

  /** 产品图（产品真身图，生成时的事实基准） */
  async getSourceImages(productId: string): Promise<{
    images: string[]
    count: number
    sourceUrl: string
    hasSourceImages: boolean
  }> {
    const { data } = await apiClient.get(`/product-images/product/${productId}/sources`)
    return data
  },

  /** 从 1688 补抓产品详情图/颜色图，返回这次新增了哪几张 */
  async fetchSourceImages(productId: string): Promise<{
    ok: boolean
    added: number
    total: number
    addedImages: string[]
    images: string[]
    mirrored: number
    failed: Array<{ url: string; error: string }>
    message: string
  }> {
    const { data } = await apiClient.post(
      `/product-images/product/${productId}/fetch-source`,
      {},
      { timeout: 180_000 }
    )
    return data
  },

  /** 手动粘贴产品图地址 / base64（后端会立刻下载转存到我们自己的存储） */
  async addSourceImages(
    productId: string,
    urls: string[]
  ): Promise<{
    images: string[]
    added: number
    mirrored: number
    failed: Array<{ url: string; error: string }>
  }> {
    const { data } = await apiClient.post(
      `/product-images/product/${productId}/sources`,
      { urls },
      { timeout: 180_000 }
    )
    return data
  },

  /** 修复破损图：把还没转存的外链产品图下载到本地存储（可只传某几张） */
  async mirrorSourceImages(
    productId: string,
    urls?: string[]
  ): Promise<{
    images: string[]
    mirrored: number
    failed: Array<{ url: string; error: string }>
  }> {
    const { data } = await apiClient.post(
      `/product-images/product/${productId}/sources/mirror`,
      urls?.length ? { urls } : {},
      { timeout: 180_000 }
    )
    return data
  },

  /** 图片体检：外链还能不能打开 */
  async checkSourceImages(productId: string): Promise<{
    results: Array<{ url: string; ok: boolean; contentType: string; bytes: number; error: string }>
  }> {
    const { data } = await apiClient.post(
      `/product-images/product/${productId}/sources/check`,
      {},
      { timeout: 120_000 }
    )
    return data
  },

  /** 删掉产品图里的一张（按地址精确匹配） */
  async removeSourceImage(productId: string, url: string): Promise<{ images: string[]; removed: number }> {
    const { data } = await apiClient.post(`/product-images/product/${productId}/sources/remove`, { url })
    return data
  },

  /** 参考图（只学构图/光线/场景，不改产品） */
  async listRefImages(
    productId: string
  ): Promise<{ refs: Array<{ id: string; url: string; createdAt: string; note: string }> }> {
    const { data } = await apiClient.get(`/product-images/product/${productId}/refs`)
    return data
  },

  async addRefImages(
    productId: string,
    payload: { urls?: string[]; images?: string[]; note?: string }
  ): Promise<{
    refs: Array<{ id: string; url: string; createdAt: string; note: string }>
    added: number
    failed: Array<{ url: string; error: string }>
  }> {
    const { data } = await apiClient.post(`/product-images/product/${productId}/refs`, payload, {
      timeout: 180_000,
    })
    return data
  },

  async deleteRefImage(refId: string): Promise<void> {
    await apiClient.delete(`/product-images/refs/${refId}`)
  },

  /**
   * 产品图片：对话式修改某张图（主图/尺寸图各自独立 AI 窗口）
   */
  async chatProductImage(
    productId: string,
    imageId: string,
    message: string
  ): Promise<{ image: ProductImage; reply: string; url: string }> {
    const { data } = await apiClient.post<{ image: ProductImage; reply: string; url: string }>(
      `/product-images/chat`,
      { productId, imageId, message },
      // 图片编辑耗时 1-2 分钟，覆盖默认 10 秒超时
      { timeout: 180000 }
    )
    return data
  },

  /**
   * 产品图片：获取介绍图拍摄建议（纯文字，不生成图片，省 AI 费用）
   */
  async fetchIntroSuggestions(productId: string): Promise<string[]> {
    const { data } = await apiClient.post<{ suggestions: string[] }>(
      `/product-images/intro-suggestions`,
      { productId },
      { timeout: 60000 }
    )
    return data.suggestions
  },

  /**
   * 产品图片：查询某产品已生成的 AI 图片列表
   */
  async listProductImages(productId: string): Promise<ProductImage[]> {
    const { data } = await apiClient.get<{ images: ProductImage[] }>(
      `/product-images/product/${productId}`
    )
    return data.images
  },

  /**
   * 产品图片：异步生成（主图/尺寸图，可选介绍图）。
   * POST 立即返回 taskId，然后轮询 GET /product-images/tasks/:taskId（解决 Render 100 秒代理超时）。
   * notes：生成前用户注意事项（中文，可空），融入 Prompt 编排。
   */
  async generateProductImages(
    productId: string,
    onProgress?: (progress: string, elapsedSec: number) => void,
    notes?: string,
    /** 生成哪些图：main/dimension/detail/scene（detail/scene 可重复给，表示张数） */
    kinds?: Array<'main' | 'dimension' | 'intro' | 'detail' | 'scene'>,
    /** 主图是否融合品牌 Logo（默认 true；false=干净产品图） */
    withLogo?: boolean,
    /** 主图样式：white=纯白底单主图；combo=产品+卖点组合展示 */
    mainStyle?: 'white' | 'combo'
  ): Promise<ProductImage[]> {
    const { data: start } = await apiClient.post<{ taskId: string; status: string }>(
      `/product-images/generate`,
      {
        productId,
        notes: (notes ?? '').trim() || undefined,
        kinds,
        withLogo: withLogo === undefined ? undefined : withLogo,
        mainStyle,
      }
    )
    const taskId = start.taskId
    if (!taskId) throw new Error('后端未返回 taskId，请检查后端版本')

    const startedAt = Date.now()
    const MAX_WAIT_MS = 10 * 60 * 1000
    const POLL_INTERVAL_MS = 3000

    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const elapsed = Date.now() - startedAt
      onProgress?.('', Math.round(elapsed / 1000))
      if (elapsed > MAX_WAIT_MS) {
        throw new Error('图片生成超时（超过 10 分钟），请重试或检查 AI 服务商状态')
      }
      let task: { status: string; result?: { images?: ProductImage[] }; progress?: string; error?: string; hint?: string }
      try {
        const { data } = await apiClient.get<{
          status: string
          result?: { images?: ProductImage[] }
          progress?: string
          error?: string
          hint?: string
        }>(`/product-images/tasks/${taskId}`)
        task = data
      } catch (err) {
        // 404 = 任务不存在（服务重启清空）；其他网络抖动继续轮询
        const msg = err instanceof Error ? err.message : String(err)
        if (/404|不存在/.test(msg)) throw new Error('任务已丢失（服务可能重启过），请重新生成')
        continue
      }
      if (task.progress) onProgress?.(task.progress, Math.round(elapsed / 1000))
      if (task.status === 'done') {
        // 从任务结果取图片；兜底再查一次列表接口
        if (task.result?.images?.length) return task.result.images
        return await api.listProductImages(productId)
      }
      if (task.status === 'error') {
        throw new Error(task.error ? `${task.error}${task.hint ? `（${task.hint}）` : ''}` : '图片生成失败，请重试')
      }
      // pending / running → 继续轮询
    }
  },

  /** 产品图片访问地址（img src 用） */
  productImageUrl(productId: string, file: string): string {
    const baseURL = import.meta.env.VITE_API_URL || '/api'
    return `${baseURL}/product-images/${productId}/${file}`
  },

  /**
   * 任意图片地址 → 可直接放进 img src 的地址。
   * 1688/alicdn 有防盗链：浏览器从我们域名直连会变成破损图，统一走服务器代理，
   * 服务器带 1688 Referer 取回再转发；已经存到我们自己存储的图片（/api/...）直接用。
   */
  proxyImageUrl(url: string | null | undefined): string {
    const u = (url ?? '').trim()
    if (!u) return ''
    if (u.startsWith('data:image/') || u.startsWith('blob:')) return u
    if (u.startsWith('/api/')) return u
    if (/^https?:\/\//i.test(u)) {
      const baseURL = import.meta.env.VITE_API_URL || '/api'
      return `${baseURL}/product-images/proxy?url=${encodeURIComponent(u)}`
    }
    return ''
  },

  /** 评估库草稿 → 产品档案（有了档案才能生成英文链接） */
  async createProductFromDraft(draftId: string): Promise<{ productId: string; created: boolean }> {
    const { data } = await apiClient.post<{ productId: string; created: boolean }>(
      `/drafts/${draftId}/product`
    )
    return data
  },

  // ---------------- 产品流水线（统一产品档案） ----------------
  /** 总览漏斗：待补资料 / 待评估 / 待生成文案 / 待审核 / 正式产品 */
  async getFlowOverview(): Promise<FlowOverview> {
    const { data } = await apiClient.get<FlowOverview>('/flow/overview')
    return data
  },

  /** 流水线列表：每条档案每一步做到哪 + 下一步该干什么 */
  async listFlowProducts(params?: { need?: string; q?: string; limit?: number }): Promise<{
    rows: FlowRow[]
    total: number
  }> {
    const { data } = await apiClient.get<{ rows: FlowRow[]; total: number }>('/flow/products', {
      params,
    })
    return data
  },

  /** 待审核 = 档案里 status='pending_review' 的那些（同一份数据，不是另开的库） */
  async listFlowReviews(
    q?: string,
    status: 'pending' | 'approved' = 'pending'
  ): Promise<{ reviews: FlowRow[]; total: number }> {
    const { data } = await apiClient.get<{ reviews: FlowRow[]; total: number }>('/flow/reviews', {
      params: { q, status },
    })
    return data
  },

  /** 驳回「已经通过」的：下架并标记驳回，文案保留，可改后重新生成再审 */
  async unapproveFlowReviews(ids: string[], note?: string): Promise<{ reverted: number }> {
    const { data } = await apiClient.post<{ reverted: number }>('/flow/reviews/unapprove', { ids, note })
    return data
  },

  /** 审核通过：这条档案原地变成正式产品 */
  async approveFlowReviews(ids: string[]): Promise<{ approved: string[]; failed: unknown[] }> {
    const { data } = await apiClient.post<{ approved: string[]; failed: unknown[] }>(
      '/flow/reviews/approve',
      { ids }
    )
    return data
  },

  /** 驳回：档案标 archived，保留资料/评估，可改后重生成 */
  async rejectFlowReviews(ids: string[], note?: string): Promise<{ rejected: number }> {
    const { data } = await apiClient.post<{ rejected: number }>('/flow/reviews/reject', { ids, note })
    return data
  },

  /** 退回「待生成文案」：清掉文案、保留档案 */
  async reopenFlowReviews(ids: string[]): Promise<{ reopened: number }> {
    const { data } = await apiClient.post<{ reopened: number }>('/flow/reviews/reopen', { ids })
    return data
  },

  /**
   * 从产品档案批量出文案：不再重新粘链接、不再重新补资料，
   * 直接把选中的档案载入批量任务，只跑「生成英文链接」这一站。
   */
  async createBatchFromProducts(
    ids: string[]
  ): Promise<{ job: BatchJob; skipped: Array<{ id: string; reason: string }> }> {
    const { data } = await apiClient.post<{
      ok: boolean
      job: BatchJob
      skipped: Array<{ id: string; reason: string }>
    }>('/batch/from-products', { ids })
    return { job: data.job, skipped: data.skipped ?? [] }
  },

  // ---------- 批量处理（粘贴多条链接 → 抓取 → 补全 → 评估 → 入库） ----------
  /** 只解析不执行：先把粘贴的文本切成条目给用户核对 */
  async parseBatch(text: string): Promise<BatchParseResult> {
    const { data } = await apiClient.post<BatchParseResult>('/batch/parse', { text })
    return data
  },

  /** 创建批量任务：只建草稿，不自动跑（先抓取，人工补全后再评估） */
  async createBatchJob(payload: {
    text: string
    options: BatchOptions
  }): Promise<{ job: BatchJob; skipped: number; truncated: boolean }> {
    const { data } = await apiClient.post<{
      ok: boolean
      job: BatchJob
      skipped: number
      truncated: boolean
    }>('/batch/jobs', payload)
    return { job: data.job, skipped: data.skipped ?? 0, truncated: Boolean(data.truncated) }
  },

  /** 跑阶段：fetch 只抓取 / evaluate 批量评估 / save 入库 / all 一口气 */
  async runBatchStage(
    id: string,
    stage: 'fetch' | 'quick' | 'evaluate' | 'listing' | 'save' | 'all',
    idxs?: number[]
  ): Promise<BatchJob> {
    const { data } = await apiClient.post<{ ok: boolean; job: BatchJob }>(
      `/batch/jobs/${id}/run`,
      { stage, idxs }
    )
    return data.job
  },

  /** 暂停：正在跑的这一条跑完就停，进度全部保留 */
  async pauseBatchJob(id: string): Promise<BatchJob> {
    const { data } = await apiClient.post<{ ok: boolean; job: BatchJob }>(`/batch/jobs/${id}/pause`)
    return data.job
  },

  /** 继续：按上次跑的阶段接着跑 */
  async resumeBatchJob(id: string): Promise<{ job: BatchJob; stage: string }> {
    const { data } = await apiClient.post<{ ok: boolean; job: BatchJob; stage: string }>(
      `/batch/jobs/${id}/resume`
    )
    return { job: data.job, stage: data.stage }
  },

  // ---------------- 英文链接待审核库 ----------------
  async listListingReviews(params: {
    status?: string
    q?: string
    limit?: number
    offset?: number
  }): Promise<{
    reviews: ListingReviewSummary[]
    counts: { pending: number; approved: number; rejected: number }
    limit: number
    offset: number
  }> {
    const { data } = await apiClient.get('/listing-reviews', { params })
    return data
  },

  async getListingReview(id: string): Promise<ListingReview> {
    const { data } = await apiClient.get<{ review: ListingReview }>(`/listing-reviews/${id}`)
    return data.review
  },

  async updateListingReview(
    id: string,
    listing: { title?: string; summary?: string; description?: string; keywords?: string[] }
  ): Promise<ListingReview> {
    const { data } = await apiClient.patch<{ review: ListingReview }>(`/listing-reviews/${id}`, { listing })
    return data.review
  },

  /** 通过 → 直接写进产品库（返回 productId） */
  async approveListingReviews(ids: string[]): Promise<{
    approved: string[]
    failed: Array<{ id: string; error: string }>
  }> {
    const { data } = await apiClient.post<{
      approved: string[]
      failed: Array<{ id: string; error: string }>
    }>('/listing-reviews/approve', { ids })
    return data
  },

  async rejectListingReviews(ids: string[], note?: string): Promise<{ rejected: number }> {
    const { data } = await apiClient.post<{ rejected: number }>('/listing-reviews/reject', {
      ids,
      note,
    })
    return data
  },

  async deleteListingReviews(ids: string[]): Promise<{ removed: number }> {
    const { data } = await apiClient.post<{ removed: number }>('/listing-reviews/bulk-delete', {
      ids,
    })
    return data
  },

  /** 改一条的资料（补全箱规等抓不到的字段）；改动会让已有评估作废 */
  async patchBatchItem(
    id: string,
    idx: number,
    input: BatchItemInput
  ): Promise<{ job: BatchJob; imagesDropped: number }> {
    const { data } = await apiClient.patch<{ ok: boolean; job: BatchJob; imagesDropped?: number }>(
      `/batch/jobs/${id}/items/${idx}`,
      { input }
    )
    return { job: data.job, imagesDropped: data.imagesDropped ?? 0 }
  },

  async getBatchJob(id: string): Promise<BatchJob> {
    const { data } = await apiClient.get<{ job: BatchJob }>(`/batch/jobs/${id}`)
    return data.job
  },

  async listBatchJobs(): Promise<{ jobs: BatchJobSummary[]; activeJobId: string | null }> {
    const { data } = await apiClient.get<{ jobs: BatchJobSummary[]; activeJobId: string | null }>(
      '/batch/jobs'
    )
    return data
  },

  async cancelBatchJob(id: string): Promise<BatchJob> {
    const { data } = await apiClient.post<{ ok: boolean; job: BatchJob }>(
      `/batch/jobs/${id}/cancel`,
      {}
    )
    return data.job
  },

  /** 重试失败项：只重跑 error 的条目，成功的保持不动 */
  async retryBatchJob(id: string): Promise<BatchJob> {
    const { data } = await apiClient.post<{ ok: boolean; job: BatchJob; reset: number }>(
      `/batch/jobs/${id}/retry`,
      {}
    )
    return data.job
  },

  async deleteBatchJob(id: string): Promise<void> {
    await apiClient.delete(`/batch/jobs/${id}`)
  },

  // ---------- 产品资料库（自建主数据） ----------
  async listMasterProducts(q?: string): Promise<MasterProduct[]> {
    const { data } = await apiClient.get<{ products: MasterProduct[] }>('/master-products', {
      params: q ? { q } : undefined,
    })
    return data.products
  },

  async lookupMaster(url: string): Promise<MasterProduct | null> {
    const { data } = await apiClient.get<{ found: MasterProduct | null }>('/master-products/lookup', {
      params: { url },
    })
    return data.found
  },

  async saveMasterProduct(
    payload: Partial<MasterProduct>
  ): Promise<{ product: MasterProduct; updated: boolean; synced?: number; repriced?: number }> {
    const { data } = await apiClient.post<{
      product: MasterProduct
      updated: boolean
      synced?: number
      repriced?: number
    }>('/master-products', payload)
    return data
  },

  async updateMasterProduct(
    id: string,
    patch: Partial<MasterProduct>
  ): Promise<{ product: MasterProduct; synced: number; repriced: number }> {
    const { data } = await apiClient.patch<{
      product: MasterProduct
      synced: number
      repriced: number
    }>(`/master-products/${id}`, patch)
    return data
  },

  async deleteMasterProduct(id: string): Promise<void> {
    await apiClient.delete(`/master-products/${id}`)
  },

  /** 批量删除资料库条目 */
  async bulkDeleteMasterProducts(ids: string[]): Promise<{ removed: number }> {
    const { data } = await apiClient.post<{ removed: number }>('/master-products/bulk-delete', { ids })
    return data
  },

  /** 从 1688 链接抓多张产品图（资料库里有图优先用资料库的） */
  async fetch1688Images(url: string): Promise<{ ok: boolean; images: string[]; source: string; message?: string }> {
    const { data } = await apiClient.post<{ ok: boolean; images: string[]; source: string; message?: string }>(
      '/products/preview/fetch-1688-images',
      { url },
      { timeout: 120_000 }
    )
    return data
  },

  /** 批量删除条目（勾选后删） */
  async deleteBatchItems(id: string, idxs: number[]): Promise<{ job: BatchJob; removed: number; skipped: number }> {
    const { data } = await apiClient.post<{ job: BatchJob; removed: number; skipped: number }>(
      `/batch/jobs/${id}/items/delete`,
      { idxs }
    )
    return data
  },

  /** 导入产品资料库（xlsx / csv，前端把文件转 base64 提交） */
  async importMasterProducts(filename: string, dataBase64: string): Promise<{
    created: number
    updated: number
    skipped: number
    errors: Array<{ row: number; error: string }>
    total: number
    pendingImages?: number
    imageTaskId?: string | null
  }> {
    const { data } = await apiClient.post<{
      created: number
      updated: number
      skipped: number
      errors: Array<{ row: number; error: string }>
      total: number
      pendingImages?: number
      imageTaskId?: string | null
    }>('/master-products/import', { filename, dataBase64 }, { timeout: 180_000 })
    return data
  },

  masterExportUrl(format: 'xlsx' | 'csv'): string {
    const baseURL = import.meta.env.VITE_API_URL || '/api'
    return `${baseURL}/master-products/export.${format}`
  },

  /** 通用异步任务查询（导入资料库后的图片解析任务等） */
  async getTask(taskId: string): Promise<{ status: string; progress?: string; error?: string; result?: unknown }> {
    const { data } = await apiClient.get<{ status: string; progress?: string; error?: string; result?: unknown }>(
      `/products/tasks/${taskId}`
    )
    return data
  },

  exportCsvUrl(): string {
    const baseURL = import.meta.env.VITE_API_URL || '/api'
    return `${baseURL}/products/export.csv`
  },
  exportSubmissionUrl(includeTrashed = false): string {
    const baseURL = import.meta.env.VITE_API_URL || '/api'
    return (
      `${baseURL}/products/export/submission.xlsx` +
      (includeTrashed ? '?include_trashed=1' : '')
    )
  },

  // ---------- 产品结构化资料（批量生产系统 V1 · 第一阶段） ----------
  async listProductSpecCards(params?: {
    q?: string
    category?: string
    filter?: 'all' | 'done' | 'missing' | 'none'
  }): Promise<{
    cards: ProductCard[]
    categories: string[]
    counts: { all: number; done: number; missing: number; none: number }
    fields: SpecFieldDef[]
  }> {
    const { data } = await apiClient.get('/product-specs/cards', { params })
    return data
  },

  async getProductSpec(productId: string): Promise<ProductSpecDetail> {
    const { data } = await apiClient.get<ProductSpecDetail>(`/product-specs/${productId}`)
    return data
  },

  /** 单条重新提取（同步，十几秒）：keepManual=false 时连人工改过的字段也一起覆盖 */
  async extractProductSpec(productId: string, keepManual = true): Promise<{ record: ProductSpecRecord }> {
    const { data } = await apiClient.post<{ record: ProductSpecRecord }>(
      `/product-specs/${productId}/extract`,
      {},
      { params: { keepManual: keepManual ? 1 : 0 }, timeout: 180_000 }
    )
    return data
  },

  async saveProductSpec(productId: string, specs: Partial<ProductSpecs>): Promise<{ record: ProductSpecRecord }> {
    const { data } = await apiClient.patch<{ record: ProductSpecRecord }>(`/product-specs/${productId}`, { specs })
    return data
  },

  // ---------- 批量生产中心（第二/四/五阶段） ----------
  async listProductionCandidates(params?: {
    q?: string
    category?: string
    only?: 'all' | 'specs-ready' | 'specs-missing' | 'has-listing' | 'no-listing'
  }): Promise<{
    cards: ProductCard[]
    categories: string[]
    counts: { all: number; specsReady: number; specsMissing: number; hasListing: number }
    limits: { max: number; suggested: number }
    fields: SpecFieldDef[]
  }> {
    const { data } = await apiClient.get('/production/candidates', { params })
    return data
  },

  async createProductionJob(payload: {
    kind: 'listing' | 'spec'
    productIds: string[]
    clientKey?: string
    note?: string
  }): Promise<{ job: ProductionJob; deduped: boolean; skipped: Array<{ productId: string; reason: string }> }> {
    const { data } = await apiClient.post('/production/jobs', payload)
    return data
  },

  async listProductionJobs(limit = 10): Promise<{ jobs: ProductionJob[] }> {
    const { data } = await apiClient.get<{ jobs: ProductionJob[] }>('/production/jobs', { params: { limit } })
    return data
  },

  async getProductionJob(id: string): Promise<{ job: ProductionJob; progress: ProductionProgress }> {
    const { data } = await apiClient.get<{ job: ProductionJob; progress: ProductionProgress }>(
      `/production/jobs/${id}`
    )
    return data
  },

  async controlProductionJob(
    id: string,
    action: 'run' | 'pause' | 'cancel' | 'retry-failed'
  ): Promise<{ job: ProductionJob }> {
    const { data } = await apiClient.post<{ job: ProductionJob }>(`/production/jobs/${id}/${action}`)
    return data
  },

  async retryProductionItem(jobId: string, idx: number): Promise<{ job: ProductionJob }> {
    const { data } = await apiClient.post<{ job: ProductionJob }>(`/production/jobs/${jobId}/items/${idx}/retry`)
    return data
  },

  async listAiCallLogs(params?: { limit?: number; task?: string }): Promise<{
    logs: AiCallLog[]
    summary: AiCallSummary[]
  }> {
    const { data } = await apiClient.get('/production/ai-logs', { params })
    return data
  },

  // ---------- 产品资料库 → 系统（导入即建档 / 批量推进） ----------
  /** 把资料库里的资料推进系统：建/复用产品档案（之后就能在流水线看到） */
  async pushMasterProducts(payload: { ids?: string[]; all?: boolean }): Promise<{
    total: number
    created: number
    existing: number
    productIds: string[]
  }> {
    const { data } = await apiClient.post('/master-products/push', payload)
    return data
  },

  // ---------- 预产品库 / RPA 档案库 / 评估库 ----------
  async listPreProducts(q?: string): Promise<{ rows: LibraryRow[]; total: number }> {
    const { data } = await apiClient.get('/library/pre-products', { params: { q } })
    return data
  },

  async listRpaArchive(q?: string): Promise<{ rows: LibraryRow[]; total: number }> {
    const { data } = await apiClient.get('/library/rpa', { params: { q } })
    return data
  },

  /** 从预产品库移进 RPA 档案库：人工给新编号（覆盖旧编号，GLS 号不再复用） */
  async archiveToRpa(entries: Array<{ productId: string; code: string }>): Promise<{
    moved: number
    failed: Array<{ productId: string; error: string }>
  }> {
    const { data } = await apiClient.post('/library/rpa/archive', { entries })
    return data
  },

  async listEvaluations(params?: { q?: string; status?: string }): Promise<{
    rows: EvaluationRow[]
    counts: { all: number; pending: number; approved: number; rejected: number; none: number; orphan: number }
    total: number
  }> {
    const { data } = await apiClient.get('/library/evaluations', { params })
    return data
  },

  /**
   * 已通过评估、文案还没生成的产品（含后台任务状态）。
   * listing 待审核中心用它显示「AI 正在跑哪一个」，不用等生成完才出现。
   */
  async getPendingGeneration(): Promise<{
    rows: Array<{
      productId: string
      code: string
      title: string
      sourceUrl: string
      updatedAt: string
      jobId: string | null
      itemIdx: number | null
      status: 'queued' | 'running' | 'failed' | 'unknown' | string
      stage: string
      error: string | null
      startedAt: string | null
    }>
    total: number
  }> {
    const { data } = await apiClient.get('/library/pending-generation')
    return data
  },

  /** 撤回审核：把误通过的产品退回「等审核」状态（文案保留在草稿里） */
  async revertToReview(ids: string[]): Promise<{ reverted: number; skipped: Array<{ id: string; reason: string }> }> {
    const { data } = await apiClient.post('/library/revert-to-review', { ids })
    return data
  },

  /** 老草稿的评估详情（还没关联产品时，评估库点「详情」用） */
  async getEvaluationDraft(draftId: string): Promise<{
    id: string
    title: string
    source: unknown
    evaluation: unknown
    priceGrid: unknown
  }> {
    const { data } = await apiClient.get(`/library/evaluations/${draftId}`)
    return data
  },

  /** 批量评估（后台跑：AI 评估 + 看图找同款，跑完自动存评估库） */
  async evaluateProducts(payload: { productIds: string[]; clientKey?: string }): Promise<{
    job: ProductionJob
    deduped: boolean
    skipped: Array<{ productId: string; reason: string }>
  }> {
    const { data } = await apiClient.post('/library/evaluate', payload)
    return data
  },

  /** 评估人工审核：通过会自动排队生成英文链接，不通过进待定 */
  async evalReview(payload: {
    ids: string[]
    decision: 'approve' | 'reject'
    note?: string
  }): Promise<{ changed: number; job: ProductionJob | null }> {
    const { data } = await apiClient.post('/library/eval-review', payload)
    return data
  },

  async toPreLibrary(ids: string[]): Promise<{ moved: Array<{ id: string; code: string; assigned: boolean }> }> {
    const { data } = await apiClient.post('/library/to-pre', { ids })
    return data
  },

  async numberingPreview(): Promise<{
    rows: Array<{ productId: string; title: string; oldCode: string; newCode: string; createdAt: string }>
    total: number
  }> {
    const { data } = await apiClient.get('/library/numbering-preview')
    return data
  },

  // ---------- 一次性数据管理（备份 / 重编号 / 删除） ----------
  async adminMigrationStatus(): Promise<{
    done: string | null
    total: number
    listed: number
    willDelete: number
    counts: Record<string, number>
    glsSeq: number
  }> {
    const { data } = await apiClient.get('/admin/migration-status')
    return data
  },

  async adminRenumberPreview(): Promise<{
    total: number
    rows: Array<{ productId: string; title: string; oldCode: string; newCode: string; createdAt: string }>
  }> {
    const { data } = await apiClient.get('/admin/renumber-preview')
    return data
  },

  async adminMigrateGls(confirm: string): Promise<{
    ok: boolean
    alreadyDone?: boolean
    deleted?: number
    renumbered?: number
    nextGls?: string
    doneAt?: string
  }> {
    const { data } = await apiClient.post('/admin/migrate-gls', { confirm })
    return data
  },

  adminBackupUrl(): string {
    return `${apiClient.defaults.baseURL}/admin/backup`
  },

  /** 批量审核：只取待审核（审核中心默认视图） */
  async listReviewQueue(params?: { status?: string; q?: string; limit?: number; offset?: number }): Promise<{
    reviews: ListingReviewSummary[]
    counts: { pending: number; approved: number; rejected: number }
    limit: number
    offset: number
  }> {
    const { data } = await apiClient.get('/listing-reviews', { params })
    return data
  },

  async getReviewDetail(id: string): Promise<{ review: ListingReview }> {
    const { data } = await apiClient.get<{ review: ListingReview }>(`/listing-reviews/${id}`)
    return data
  },

  /** 按产品取最新一条审核记录（产品页在「还没写回产品」时用它显示待审核的文案） */
  async getReviewByProduct(productId: string): Promise<{
    review: {
      id: string
      status: 'pending' | 'approved' | 'rejected'
      mode: 'inline' | 'staged'
      listing: Listing
      qc?: ListingQcReport | null
      editedAt?: string | null
      createdAt: string
    } | null
  }> {
    const { data } = await apiClient.get(`/listing-reviews/by-product/${productId}`)
    return data
  },

  async patchReviewListing(id: string, listing: Partial<Listing>): Promise<{ review: ListingReview }> {
    const { data } = await apiClient.patch<{ review: ListingReview }>(`/listing-reviews/${id}`, { listing })
    return data
  },

  /** 只重生成指定字段（标题/摘要/描述/关键词），结果直接并回这条草稿 */
  async regenerateReviewFields(
    id: string,
    fields: Array<'title' | 'summary' | 'description' | 'keywords'>,
    instruction?: string
  ): Promise<{ review: ListingReview; qc: ListingQcReport }> {
    const { data } = await apiClient.post<{ review: ListingReview; qc: ListingQcReport }>(
      `/listing-reviews/${id}/regenerate-fields`,
      { fields, instruction },
      LONG_TIMEOUT
    )
    return data
  },

  async reviewAiQc(id: string): Promise<{ qc: ListingQcReport; findings: string[] }> {    const { data } = await apiClient.post<{ qc: ListingQcReport; findings: string[] }>(
      `/listing-reviews/${id}/ai-qc`,
      {},
      LONG_TIMEOUT
    )
    return data
  },

  async reviewBulkAiQc(ids: string[]): Promise<{
    results: Array<{ id: string; ok: boolean; findings: string[]; error?: string }>
  }> {
    const { data } = await apiClient.post('/listing-reviews/ai-qc', { ids }, LONG_TIMEOUT)
    return data
  },

  /** 驳回「已经通过」的文案（通过之后反悔） */
  async unapproveReviews(ids: string[], note?: string): Promise<{
    reverted: number
    skipped: Array<{ id: string; error: string }>
  }> {
    const { data } = await apiClient.post<{ reverted: number; skipped: Array<{ id: string; error: string }> }>(
      '/listing-reviews/unapprove',
      { ids, note }
    )
    return data
  },

  async approveReviews(ids: string[]): Promise<{ approved: string[]; failed: Array<{ id: string; error: string }> }> {
    const { data } = await apiClient.post('/listing-reviews/approve', { ids })
    return data
  },

  async rejectReviews(ids: string[], note?: string): Promise<{ rejected: number }> {
    const { data } = await apiClient.post('/listing-reviews/reject', { ids, note })
    return data
  },

  async deleteReviews(ids: string[]): Promise<{ removed: number }> {
    const { data } = await apiClient.post('/listing-reviews/bulk-delete', { ids })
    return data
  },

  /** 导出批量生成结果（Excel）：直接触发浏览器下载 */
  reviewExportUrl(params: { ids?: string[]; status?: string }): string {
    const qs = new URLSearchParams()
    if (params.ids?.length) qs.set('ids', params.ids.join(','))
    if (params.status) qs.set('status', params.status)
    return `${apiClient.defaults.baseURL}/listing-reviews/export?${qs.toString()}`
  },
}

/** 把 Listing 整理为可直接粘贴的纯文本（含中英对照） */
export function listingToText(listing: Listing): string {
  const grid = listing.priceGrid ?? []
  const sections: string[] = [
    `PRODUCT TITLE\n${listing.title}`,
    `\nSUMMARY DESCRIPTION\n${listing.summary}`,
    `\nTITLE (中文)\n${listing.titleZh || ''}`,
    `\nSUMMARY (中文)\n${listing.summaryZh || ''}`,
    `\nKEYWORDS\n${(listing.keywords ?? []).join(', ')}`,
    `\nKEYWORDS (中文参考)\n${listing.keywordsZh || ''}`,
    `\nCATEGORY\n${listing.category}`,
    `\nTHEMES\n${(listing.themes ?? []).join('\n')}`,
    `\nMATERIAL\n${listing.material}`,
    `\nCOLORS\n${listing.colors}${
      listing.colorChips?.length ? ` (${listing.colorChips.join(' / ')})` : ''
    }`,
    `\nIMPRINT METHODS\n${(listing.imprintMethods ?? []).join('/')}`,
    `\nIMPRINT AREA\n${listing.imprintArea}`,
    `\nPRODUCTION TIME\n${listing.productionTime}`,
    `\nPRODUCT SIZE\n${listing.productSizeInch || '-'}`,
    `\nUNIT WEIGHT\n${listing.unitWeightLb ? `${listing.unitWeightLb} lb` : '-'}`,
    `\nCARTON SIZE\n${listing.cartonSizeInch || '-'}`,
    `\nCARTON GROSS WEIGHT\n${listing.cartonGwLb ? `${listing.cartonGwLb} lb` : '-'}`,
    `\nPACKAGING\n${listing.packaging}`,
    `\nFULL DESCRIPTION\n${listing.description}`,
    `\nFULL DESCRIPTION (中文)\n${listing.descriptionZh || ''}`,
  ]
  if (grid.length) {
    sections.push(
      `\nPRICE GRID (8C)\n${grid
        .map(
          (r) =>
            `${r.qty} pcs [${r.shipping.toUpperCase()}, billable ${r.billableKg}kg, cost ¥${r.unitCostCny.toFixed(
              2
            )}, markup ×${r.markupRate}]: $${r.unitPrice.toFixed(2)} (margin ${r.margin.toFixed(0)}%)`
        )
        .join('\n')}`
    )
  }
  if (listing.warnings?.length) {
    sections.push(`\nNOTES & WARNINGS\n${listing.warnings.map((w) => `- ${w}`).join('\n')}`)
  }
  if (listing.qc?.issues?.length) {
    sections.push(`\nQC\n${listing.qc.issues.map((w) => `- ${w}`).join('\n')}`)
  }
  return sections.join('\n')
}

// ========== 订单运营中心 API ==========

export const orderApi = {
  // ---------- Dashboard ----------
  async dashboardOverview(): Promise<DashboardOverview> {
    const { data } = await apiClient.get<DashboardOverview>('/dashboard/overview')
    return data
  },

  async pendingTasks(): Promise<PendingTasks> {
    const { data } = await apiClient.get<PendingTasks>('/dashboard/pending-tasks')
    return data
  },

  // ---------- 客户 ----------
  async listCustomers(): Promise<Customer[]> {
    const { data } = await apiClient.get<{ customers: Customer[] }>('/customers')
    return data.customers
  },

  async searchCustomers(q: string): Promise<Customer[]> {
    const { data } = await apiClient.get<{ customers: Customer[] }>('/customers/search', { params: { q } })
    return data.customers
  },

  async createCustomer(payload: {
    name: string
    company?: string
    email: string
    phone?: string
    address?: string
    country?: string
    type: CustomerType
    notes?: string
  }): Promise<Customer> {
    const { data } = await apiClient.post<{ customer: Customer }>('/customers', payload)
    return data.customer
  },

  async updateCustomer(
    id: string,
    patch: Partial<{
      name: string
      company: string
      email: string
      phone: string
      address: string
      country: string
      type: CustomerType
      notes: string
    }>
  ): Promise<Customer> {
    const { data } = await apiClient.put<{ customer: Customer }>(`/customers/${id}`, patch)
    return data.customer
  },

  async deleteCustomer(id: string): Promise<void> {
    await apiClient.delete(`/customers/${id}`)
  },

  // ---------- 询盘 ----------
  async listInquiries(params?: { status?: string; customerId?: string }): Promise<Inquiry[]> {
    const { data } = await apiClient.get<{ inquiries: Inquiry[] }>('/inquiries', { params })
    return data.inquiries
  },

  async createInquiry(payload: {
    customerId: string
    subject: string
    content: string
    type: Inquiry['type']
    productId?: string
  }): Promise<Inquiry> {
    const { data } = await apiClient.post<{ inquiry: Inquiry }>('/inquiries', payload)
    return data.inquiry
  },

  async updateInquiryStatus(id: string, status: InquiryStatus): Promise<Inquiry> {
    const { data } = await apiClient.patch<{ inquiry: Inquiry }>(`/inquiries/${id}/status`, { status })
    return data.inquiry
  },

  async categorizeInquiry(id: string): Promise<Inquiry> {
    const { data } = await apiClient.post<{ inquiry: Inquiry }>(`/inquiries/${id}/ai-categorize`, {})
    return data.inquiry
  },

  async deleteInquiry(id: string): Promise<void> {
    await apiClient.delete(`/inquiries/${id}`)
  },

  // ---------- 订单 ----------
  async listOrders(params?: { status?: string; customerId?: string }): Promise<Order[]> {
    const { data } = await apiClient.get<{ orders: Order[] }>('/orders', { params })
    return data.orders
  },

  async createOrder(payload: {
    customerId: string
    orderNumber: string
    status?: OrderStatus
    paymentStatus?: PaymentStatus
    totalAmount?: number
    depositAmount?: number
    balanceAmount?: number
    notes?: string
    items: Array<{ productId: string; quantity: number; unitPrice: number; imprintSpec?: string }>
  }): Promise<{ order: Order; items: OrderItem[] }> {
    const { data } = await apiClient.post<{ order: Order; items: OrderItem[] }>('/orders', payload)
    return data
  },

  async updateOrderStatus(id: string, status: OrderStatus): Promise<Order> {
    const { data } = await apiClient.patch<{ order: Order }>(`/orders/${id}/status`, { status })
    return data.order
  },

  async updateOrderPaymentStatus(id: string, paymentStatus: PaymentStatus): Promise<Order> {
    const { data } = await apiClient.patch<{ order: Order }>(`/orders/${id}/payment-status`, { paymentStatus })
    return data.order
  },

  async deleteOrder(id: string): Promise<void> {
    await apiClient.delete(`/orders/${id}`)
  },

  // ---------- 供应商沟通 ----------
  async listCommunications(params?: { productId?: string }): Promise<SupplierCommunication[]> {
    const { data } = await apiClient.get<{ communications: SupplierCommunication[] }>('/supplier-communications', { params })
    return data.communications
  },

  async createCommunication(payload: {
    productId: string
    supplierName: string
    contactMethod: SupplierCommunication['contactMethod']
    content: string
    response?: string
    priceCny?: number
    moq?: number
    leadTime?: string
  }): Promise<SupplierCommunication> {
    const { data } = await apiClient.post<{ communication: SupplierCommunication }>('/supplier-communications', payload)
    return data.communication
  },

  async updateCommunication(
    id: string,
    patch: Partial<{
      supplierName: string
      contactMethod: SupplierCommunication['contactMethod']
      content: string
      response: string
      priceCny: number
      moq: number
      leadTime: string
    }>
  ): Promise<SupplierCommunication> {
    const { data } = await apiClient.put<{ communication: SupplierCommunication }>(`/supplier-communications/${id}`, patch)
    return data.communication
  },

  async deleteCommunication(id: string): Promise<void> {
    await apiClient.delete(`/supplier-communications/${id}`)
  },

  async priceComparison(productId: string): Promise<PriceComparison[]> {
    const { data } = await apiClient.get<{ comparison: PriceComparison[] }>(
      `/supplier-communications/product/${productId}/price-comparison`
    )
    return data.comparison
  },

  // ---------- 邮件草稿 ----------
  async listEmailDrafts(params?: { customerId?: string; inquiryId?: string; status?: string }): Promise<EmailDraft[]> {
    const { data } = await apiClient.get<{ emailDrafts: EmailDraft[] }>('/email-drafts', { params })
    return data.emailDrafts
  },

  async createEmailDraft(payload: {
    inquiryId?: string
    customerId: string
    subject: string
    content: string
  }): Promise<EmailDraft> {
    const { data } = await apiClient.post<{ emailDraft: EmailDraft }>('/email-drafts', payload)
    return data.emailDraft
  },

  async generateEmailDraft(payload: {
    inquiryId?: string
    customerId: string
    tone?: 'professional' | 'friendly' | 'formal'
  }): Promise<EmailDraft> {
    const { data } = await apiClient.post<{ emailDraft: EmailDraft }>('/email-drafts/ai-generate', payload, LONG_TIMEOUT)
    return data.emailDraft
  },

  async markEmailSent(id: string): Promise<EmailDraft> {
    const { data } = await apiClient.patch<{ emailDraft: EmailDraft }>(`/email-drafts/${id}/send`, {})
    return data.emailDraft
  },

  async deleteEmailDraft(id: string): Promise<void> {
    await apiClient.delete(`/email-drafts/${id}`)
  },
}
