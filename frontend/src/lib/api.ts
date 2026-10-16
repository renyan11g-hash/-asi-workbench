import apiClient, { getErrorMessage } from './api-client'
import { Evaluation, Listing, PriceRow, Product, ProductStatus, Settings, SimilarResearch, SourceInfo } from '../types'

const LONG_TIMEOUT = { timeout: 180_000 }

export { getErrorMessage }

export interface SettingsResponse {
  settings: Settings
  hasApiKey: boolean
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
    status?: ProductStatus
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
    answers?: Array<{ id: string; question: string; answer: string }>
  ): Promise<Listing> {
    const { data } = await apiClient.post<{ listing: Listing }>(
      '/products/preview/listing',
      { source, answers },
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

  async generateProductListing(
    id: string,
    answers?: Array<{ id: string; question: string; answer: string }>
  ): Promise<Product> {
    const { data } = await apiClient.post<{ product: Product }>(
      `/products/${id}/listing`,
      answers ? { answers } : {},
      LONG_TIMEOUT
    )
    return data.product
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
    `\nTHEMES\n${(listing.themes ?? []).join(', ')}`,
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