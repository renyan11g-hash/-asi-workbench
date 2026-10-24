import apiClient, { getErrorMessage } from './api-client'
import {
  Customer,
  CustomerType,
  DashboardOverview,
  EmailDraft,
  Evaluation,
  Inquiry,
  InquiryStatus,
  Listing,
  Order,
  OrderItem,
  OrderStatus,
  PaymentStatus,
  PendingTasks,
  PriceComparison,
  PriceRow,
  Product,
  ProductStatus,
  Settings,
  SimilarResearch,
  SourceInfo,
  SupplierCommunication,
} from '../types'

/** AI 生成类接口耗时较长：默认 10 分钟，需与后端 AI_TIMEOUT_MS 保持一致 */
const LONG_TIMEOUT = { timeout: 600_000 }

export { getErrorMessage }

export interface SettingsResponse {
  settings: Settings
  hasApiKey: boolean
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

  async listProducts(params?: { status?: string; q?: string }): Promise<Product[]> {
    const { data } = await apiClient.get<{ products: Product[] }>('/products', { params })
    return data.products
  },

  async getProduct(id: string): Promise<Product> {
    const { data } = await apiClient.get<{ product: Product }>(`/products/${id}`)
    return data.product
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

  async previewEvaluate(source: SourceInfo): Promise<{ evaluation: Evaluation; priceGrid: PriceRow[] }> {
    const { data } = await apiClient.post<{ evaluation: Evaluation; priceGrid: PriceRow[] }>(
      '/products/preview/evaluate',
      { source },
      LONG_TIMEOUT
    )
    return data
  },

  async previewListing(
    source: SourceInfo,
    answers?: Array<{ id: string; question: string; answer: string }>,
    similar?: SimilarResearch | Record<string, unknown> | null
  ): Promise<Listing> {
    const { data } = await apiClient.post<{ listing: Listing }>(
      '/products/preview/listing',
      { source, answers, similar },
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

  async listAiProviders(): Promise<{
    providers: Array<{
      id: string
      name: string
      baseUrl: string
      models: string[]
      keyUrl: string
      needsProxy: boolean
      supportsVision: boolean
      priceNote: string
      note: string
    }>
  }> {
    const { data } = await apiClient.get('/settings/ai-providers')
    return data
  },

  // ---------- 印刷方式推荐（本地规则引擎，无需 AI） ----------
  async imprintRecommend(
    source: SourceInfo
  ): Promise<{
    recommendations: Array<{
      id: string
      nameZh: string
      why: string
      pros: string[]
      cons: string[]
      bestFor: string
    }>
    materialProfiles: Array<{ name: string; nameZh: string; pros: string[]; cons: string[] }>
    materialTags: string[]
    summary: string
  }> {
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

  async reprice(id: string): Promise<Product> {
    const { data } = await apiClient.post<{ product: Product }>(
      `/products/${id}/reprice`,
      {},
      LONG_TIMEOUT
    )
    return data.product
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