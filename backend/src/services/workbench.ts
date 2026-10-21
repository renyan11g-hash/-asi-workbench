import { Evaluation, Listing, PriceRow, Settings, SimilarResearch, SourceInfo } from '../types'
import {
  ASI_CATEGORIES,
  ASI_THEMES,
  ASI_MATERIALS,
  ASI_IMPRINT_METHODS,
  BRAND_BLOCKLIST,
  DEFAULT_THEMES,
  ILOVECARGO_RULES,
  LIMITS,
  SEED_KEYWORDS,
  detectColors,
  detectMaterial,
  detectMaterials,
  toTitleCase,
  translateColors,
} from '../constants/asi'
import { buildAssistantPrompt, buildChatEvaluationPrompt, buildEvaluatePrompt, buildFieldsRegeneratePrompt, buildFindSimilarPrompt, buildListingPrompt, buildListingQuestionsPrompt, buildSourcingPrompt, buildSourcingResearchPrompt, ChatMessage, ListingAnswer } from './prompts'
import { GLS_CATEGORIES } from '../constants/gls-categories'
import { AiError, callChatJson } from './ai'
import { buildPriceGrid, convertUnits } from './pricing'
import { estimateImprintArea, estimateToImprintString } from './imprint'
const arr = (v: unknown, fallback: string[] = []): string[] => {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return v.split(',').map((x) => x.trim()).filter(Boolean)
  return fallback
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const pickEnum = (allowed: readonly string[], value: unknown, fallback: string): string => {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) return fallback
  const hit = allowed.find((x) => x.toLowerCase() === s.toLowerCase())
  return hit ?? fallback
}

const pickEnumMany = (allowed: readonly string[], values: unknown): string[] => {
  const list = arr(values)
  const set = new Set<string>()
  for (const v of list) {
    const hit = allowed.find((x) => x.toLowerCase() === v.toLowerCase())
    if (hit) set.add(hit)
  }
  return Array.from(set)
}

function normalizeEvaluation(raw: Record<string, unknown>): Evaluation {
  const score = Math.max(0, Math.min(100, Math.round(num(raw.score, 50))))
  const verdict = score >= 75 ? 'GO' : score >= 55 ? 'MAYBE' : 'NO'
  const price = (raw.priceAdviceUsd ?? {}) as Record<string, unknown>
  return {
    score,
    verdict: (raw.verdict === 'GO' || raw.verdict === 'MAYBE' || raw.verdict === 'NO'
      ? raw.verdict
      : verdict) as Evaluation['verdict'],
    summary: String(raw.summary ?? '').trim(),
    pros: arr(raw.pros),
    cons: arr(raw.cons),
    /** 弱点 + 改善建议：与 AI 输出对齐，老数据缺则用 cons 兜底 */
    issues: arr(raw.issues).length ? arr(raw.issues) : arr(raw.cons),
    suggestions: arr(raw.suggestions).length ? arr(raw.suggestions) : [],
    risks: arr(raw.risks),
    buyers: arr(raw.buyers),
    occasions: arr(raw.occasions),
    channels: arr(raw.channels),
    asiCategories: arr(raw.asiCategories),
    suggestedThemes: pickEnumMany(ASI_THEMES, raw.suggestedThemes ?? []),
    priceAdviceUsd: { min: num(price.min, 0), max: num(price.max, 0) },
    sourcingTips: String(raw.sourcingTips ?? '').trim(),
    listingHooks: arr(raw.listingHooks),
    evaluatedAt: new Date().toISOString(),
  }
}

/** 规则评分（无 AI 时兜底） */
export function heuristicEvaluate(source: SourceInfo, settings: Settings): Evaluation {
  const text = [
    source.sourceTitle,
    source.description,
    source.materialCn,
    source.colorsCn,
    source.sizeCn,
    source.category,
    source.notes,
  ]
    .filter(Boolean)
    .join(' ')
  const { rows } = buildPriceGrid(source, settings)
  const mid = rows[Math.min(2, rows.length - 1)]

  let score = 55
  const pros: string[] = []
  const cons: string[] = []
  const risks: string[] = []

  if (mid && mid.unitPrice >= 1.5 && mid.unitPrice <= 25) {
    score += 12
    pros.push(`首档测算售价 $${mid.unitPrice.toFixed(2)}，落在促销礼品主流价格带`)
  } else if (mid) {
    score -= 8
    cons.push(`首档测算售价 $${mid.unitPrice.toFixed(2)}，偏离 $1.5-$25 主流促销价格带`)
  }

  const printable = /不锈钢|塑料|abs|pp|pc|棉|涤|帆布|硅胶|亚克力|竹|木|铝|皮革|尼龙|纸|陶瓷/i
  if (printable.test(text)) {
    score += 10
    pros.push('材质常见，可丝印 / 激光 / 热转印，定制适配度高')
  } else {
    risks.push('材质未识别为常见可印刷基材，打样前务必确认印花可行性')
  }

  if (new RegExp(BRAND_BLOCKLIST.join('|'), 'i').test(text)) {
    score -= 35
    risks.push('标题疑似含品牌或卡通 IP 元素，美国站上架有侵权下架风险')
  }
  if (/食品|零食|饮料|奶粉|保健|化妆|精油|液体|膏|霜/i.test(text)) {
    score -= 15
    risks.push('涉及食品 / 化妆品 / 液体类目，需要 FDA 或相关认证')
  }
  if (/儿童|婴儿|宝宝|kids|baby/i.test(text)) {
    score -= 12
    risks.push('儿童用品需满足 CPSIA 检测与溯源标签要求')
  }
  if (/电池|内置电|充电|蓝牙|led|usb|type-?c|无线/i.test(text)) {
    risks.push('含电子 / 电池元件，需确认运输方式与必要认证（UN38.3 / FCC / UL）')
  }
  if (/易碎|玻璃|陶瓷|镜面/i.test(text)) {
    score -= 10
    risks.push('易碎品破损率高，需确认包装跌落测试与理赔条款')
  }

  if (!source.cartonLCm || !source.pcsPerCarton) {
    risks.push('缺少箱规（L×W×H）或每箱数量，无法用 ASI 标准体积重公式精确报价')
    score -= 6
  }

  score = Math.max(0, Math.min(100, score))
  const verdict: Evaluation['verdict'] = score >= 75 ? 'GO' : score >= 55 ? 'MAYBE' : 'NO'

  return {
    score,
    verdict,
    summary: `规则引擎评分 ${score} 分（未接入 AI，基于重量、成本与合规关键词测算）。${
      mid ? `首档测算售价 $${mid.unitPrice.toFixed(2)}，毛利率约 ${mid.margin.toFixed(0)}%。` : ''
    }建议：${verdict === 'GO' ? '可优先上架测款' : verdict === 'MAYBE' ? '先拿样确认品质与印花效果再决定' : '除非有明确客户订单，否则不推荐'}`,
    pros,
    cons,
    issues: cons.length ? cons : ['当前未配置 AI，无法给出具体弱点；建议配置后重新评估'],
    suggestions: [
      '配置 DeepSeek/OpenAI Key 后重新评估，可拿到具体弱点与策略',
      '补齐 1688 描述里的颜色、印花方式、箱规（L×W×H / 每箱数 / 毛重）',
      '上传 2-4 张产品主图，AI 可基于图片建议 ASI 类目与亚马逊对标',
    ],
    risks,
    buyers: [],
    occasions: [],
    channels: [],
    asiCategories: source.category ? [source.category] : [],
    suggestedThemes: Array.from(DEFAULT_THEMES) as unknown as string[],
    priceAdviceUsd: mid ? { min: rows[rows.length - 1].unitPrice, max: rows[0].unitPrice } : { min: 0, max: 0 },
    sourcingTips: '配置 AI 后可以获得更完整的买家画像、场景建议与谈判要点。',
    listingHooks: [],
    evaluatedAt: new Date().toISOString(),
  }
}

export async function evaluateSource(source: SourceInfo, settings: Settings): Promise<Evaluation> {
  if (!settings.aiApiKey?.trim()) return heuristicEvaluate(source, settings)
  const { system, user } = buildEvaluatePrompt(source, settings)
  const raw = await callChatJson<Record<string, unknown>>(settings, system, user, 0.3)
  return normalizeEvaluation(raw)
}

/** 多轮对话调整评估：保留历史，由 AI 输出完整新评估 */
export async function chatEvaluateSource(
  source: SourceInfo,
  currentEval: Evaluation,
  messages: ChatMessage[],
  settings: Settings
): Promise<{ evaluation: Evaluation; assistantReply: string }> {
  if (!settings.aiApiKey?.trim()) {
    // 无 AI：直接返回原评估，assistantReply 提示用户
    return {
      evaluation: currentEval,
      assistantReply: '当前未配置 AI（请到「设置」配置 API Key）。评估未做调整。',
    }
  }
  const { system, user } = buildChatEvaluationPrompt(source, currentEval, messages)
  const raw = await callChatJson<Record<string, unknown>>(settings, system, user, 0.4)
  const evaluation = normalizeEvaluation(raw)
  // 把最后一条 assistant 内容作为对话气泡——重新解析
  return {
    evaluation,
    assistantReply:
      evaluation.summary || '已根据您的输入更新评估。请查看上方分数与建议。',
  }
}

/** 清理并限制单条关键词：≤30 字符、≤4 单词、Title Case、剔除品牌词 */
function cleanKeyword(k: string): string {
  let v = k.trim()
  if (!v) return ''
  // 去前后引号
  v = v.replace(/^["']+|["']+$/g, '')
  // 拆词并 Title Case
  const parts = v.split(/\s+/).filter(Boolean)
  const filtered = parts.filter((w) => {
    const wlow = w.toLowerCase().replace(/[^a-z0-9]/g, '')
    return !BRAND_BLOCKLIST.includes(wlow)
  })
  if (filtered.length > LIMITS.keywordWords) return ''
  v = filtered.map(toTitleCase).join(' ')
  if (v.length > LIMITS.keywordGroup) v = v.slice(0, LIMITS.keywordGroup).trim()
  return v
}

/**
 * 关键词清洗 + 单词级全局去重 + 限 30 组。
 * 与下游去重工具（把所有词拆开全局去重后再重新打包）对齐：
 * 任一英文单词在全部 30 组中只允许出现一次，否则该组会被工具拆散，等效于无效关键词。
 * 不足 30 组时用互不共享单词的填充词补齐。
 */
function cleanKeywordList(input: unknown): string[] {
  const list: string[] = []
  const seenGroups = new Set<string>()
  const seenWords = new Set<string>()
  const tryPush = (s: string): boolean => {
    const cleaned = cleanKeyword(s)
    if (!cleaned) return false
    const words = cleaned.toLowerCase().split(/\s+/)
    // 组内单词重复（如 "Cable Cable"）直接丢弃
    if (new Set(words).size !== words.length) return false
    if (words.some((w) => seenWords.has(w))) return false
    seenGroups.add(cleaned.toLowerCase())
    for (const w of words) seenWords.add(w)
    list.push(cleaned)
    return true
  }
  for (const s of arr(input)) {
    if (list.length >= LIMITS.keywordMax) break
    tryPush(s)
  }
  // 不足 30 组：用互不共享单词的填充词补齐（填充词库本身已保证单词唯一，按顺序消费）
  if (list.length < LIMITS.keywordMax) {
    for (const f of KEYWORD_FILLERS) {
      if (list.length >= LIMITS.keywordMax) break
      tryPush(f)
    }
  }
  return list
}

/** 补齐用填充词：全部经过单词级唯一性设计，按顺序消费即可填满 30 组 */
const KEYWORD_FILLERS: readonly string[] = [
  ...SEED_KEYWORDS,
  'Promotional Gift', 'Bulk Order', 'Wholesale Merchandise', 'Trade Show Giveaway',
  'Corporate Appreciation', 'Client Thank You', 'Event Handout', 'Business Swag',
  'Brand Awareness', 'Marketing Campaign', 'Company swag', 'Employee Recognition',
  'Trade Fair', 'Expo Souvenir', 'Convention Loot', 'Festival Freebie',
  'Office Stationery', 'Desk Accessory', 'Travel Companion', 'Outdoor Essential',
  'Everyday Carry', 'Gift Set', 'Party Favor', 'Stocking Stuffer',
  'Grand Opening', 'New Hire', 'Safety Award', 'Sales Incentive',
  'Fundraising Premium', 'Voter Outreach', 'Nonprofit Donor', 'School Spirit',
  'Fitness Challenge', 'Wellness Program', 'Eco Friendly', 'Reusable Alternative',
  'Made Sustainably', 'Factory Direct', 'OEM Service', 'Fast Lead Time',
]

function ensureRushSuffix(s: string): string {
  const trimmed = (s ?? '').trim()
  if (!trimmed) return 'Rush service is available'
  // 已经以 Rush 结尾（大小写宽松）就不再加
  if (/rush service is available\.?\s*$/i.test(trimmed)) return trimmed
  // 截掉末尾重复，拼接
  const stripped = trimmed.replace(/[.\s]+$/, '')
  return `${stripped} Rush service is available`
}

function enforceLength(s: string, max: number): string {
  if (!s) return s
  if (s.length <= max) return s
  // 在最后一个空格处截断，避免切到单词中间
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()
}

export function applyQc(listing: Listing): Listing {
  const issues: string[] = []
  let title = listing.title
  let summary = listing.summary
  let description = listing.description
  // 关键词：上限 30 组；不足 30 组时自动补齐（与 AI 生成规则一致）
  let keywords = cleanKeywordList(listing.keywords)

  if (title.length > LIMITS.title) {
    issues.push(`标题 ${title.length} 字符，超出 ${LIMITS.title} 限制`)
    title = enforceLength(title, LIMITS.title)
  }
  summary = ensureRushSuffix(summary)
  if (summary.length > LIMITS.summary) {
    issues.push(`摘要 ${summary.length} 字符，超出 ${LIMITS.summary} 限制`)
    summary = enforceLength(summary, LIMITS.summary - ' Rush service is available'.length)
    summary = ensureRushSuffix(summary)
  }
  if (description.length > LIMITS.description) {
    issues.push(`描述 ${description.length} 字符，超出 ${LIMITS.description} 限制`)
    description = enforceLength(description, LIMITS.description)
  }
  title = title.replace(/\s+/g, ' ').trim()

  // 主题必含 Anniversary + Sustainable
  const themes = Array.from(new Set([...listing.themes, ...DEFAULT_THEMES]))
  if (themes.length < LIMITS.themes) {
    const candidates = ['Trade Show', 'Corporate', 'Eco & Environmentally Friendly', 'Wellness']
    for (const c of candidates) {
      if (themes.length >= LIMITS.themes) break
      if (!themes.includes(c)) themes.push(c)
    }
  }
  const themesFinal = themes.slice(0, LIMITS.themes)

  // 印刷方式必填：Silkscreen / Unimprinted / Full Color
  const REQUIRED_IMPRINTS = ['Silkscreen', 'Unimprinted', 'Full Color']
  const imprints = Array.from(new Set([...REQUIRED_IMPRINTS, ...listing.imprintMethods]))
  // 不设上限：用户未要求 ≤6，保留 AI 给出的全部合法项（去重后）
  const imprintsFinal = imprints

  // 材质：保证 material 与 materials 一致（material 是主显字符串，materials 是数组）
  const materialsFinal =
    listing.materials && listing.materials.length
      ? Array.from(new Set(listing.materials.map((m) => pickEnum(ASI_MATERIALS, m, listing.material))))
          .filter(Boolean)
      : []
  if (materialsFinal.length && !materialsFinal.includes(listing.material)) {
    listing.material = materialsFinal[0]
  }

  return {
    ...listing,
    title,
    summary,
    description,
    keywords,
    themes: themesFinal,
    imprintMethods: imprintsFinal,
    materials: materialsFinal.length ? materialsFinal : listing.materials,
    qc: {
      titleLen: title.length,
      summaryLen: summary.length,
      descriptionLen: description.length,
      keywordCount: keywords.length,
      ok: issues.length === 0,
      issues,
      // ilovecargo.com/tool/encode 等价校验（前端 QC 卡按此输出绿/红）
      ilovecargo: buildIlovecargoReport(listing, {
        title,
        summary,
        description,
        keywords,
        themes: themesFinal,
        imprintMethods: imprintsFinal,
      }),
    },
  }
}

/** 等价于 ilovecargo.com/tool/encode 的 ASI 标准检测报告。每一项 = 平台上点一次 check。 */
export interface IlovecargoRuleReport {
  key: string
  label: string
  ok: boolean
  value: number | string
  reason?: string
}

export function buildIlovecargoReport(
  _orig: Listing,
  normalized: { title: string; summary: string; description: string; keywords: string[]; themes: string[]; imprintMethods: string[] }
): IlovecargoRuleReport[] {
  const out: IlovecargoRuleReport[] = []
  for (const rule of ILOVECARGO_RULES) {
    if (rule.key === 'titleLen') {
      const v = normalized.title.length
      out.push({ key: rule.key, label: rule.label, ok: v <= rule.max, value: v })
    } else if (rule.key === 'summaryLen') {
      const v = normalized.summary.length
      const rush = /rush service is available\.?\s*$/i.test(normalized.summary)
      out.push({
        key: rule.key,
        label: rule.label,
        ok: v <= rule.max && rush,
        value: v,
        reason: !rush ? '末尾未含 "Rush service is available"' : undefined,
      })
    } else if (rule.key === 'descriptionLen') {
      const v = normalized.description.length
      out.push({ key: rule.key, label: rule.label, ok: v <= rule.max, value: v })
    } else if (rule.key === 'keywordCount') {
      const v = normalized.keywords.length
      out.push({ key: rule.key, label: rule.label, ok: v === rule.max, value: v, reason: v !== rule.max ? `实际 ${v} 组，需恰好 ${rule.max} 组` : undefined })
    } else if (rule.key === 'themesCount') {
      const v = normalized.themes.length
      const contains = (rule.requiredContains ?? []).every((c) => normalized.themes.includes(c))
      out.push({
        key: rule.key,
        label: rule.label,
        ok: v === rule.expected && contains,
        value: v,
        reason: !contains ? `缺 ${(rule.requiredContains ?? []).filter((c) => !normalized.themes.includes(c)).join(', ')}` : undefined,
      })
    } else if (rule.key === 'imprintRequired') {
      const miss = (rule.required ?? []).filter((c) => !normalized.imprintMethods.includes(c))
      out.push({
        key: rule.key,
        label: rule.label,
        ok: miss.length === 0,
        value: `${normalized.imprintMethods.length} 项`,
        reason: miss.length ? `缺 ${miss.join(', ')}` : undefined,
      })
    }
  }
  return out
}

/** 无 AI 时的 Listing 骨架（保留旧入口用于兼容） */
function buildSkeletonListing(source: SourceInfo, settings: Settings): Listing {
  const material = detectMaterial(source.materialCn) || pickEnum(ASI_MATERIALS, '', 'Other')
  const detectedColors = detectColors(source.colorsCn)
  const colorsString =
    translateColors(source.colorsCn) ||
    (detectedColors.length ? detectedColors.join('/') : 'Black/White')
  const colorChips = detectedColors.length ? detectedColors : ['Black', 'White']
  const units = convertUnits(source)
  const themes = Array.from(DEFAULT_THEMES) as unknown as string[]
  const imprintMethods = settings.defaultImprintMethods?.length
    ? settings.defaultImprintMethods.filter((m) =>
        (ASI_IMPRINT_METHODS as readonly string[]).some((x) => x.toLowerCase() === m.toLowerCase())
      )
    : []
  // 必填：Silkscreen + Unimprinted + Full Color
  const imprintsSet = new Set<string>(['Silkscreen', 'Unimprinted', 'Full Color', ...imprintMethods])
  const imprintMethodsFinal = Array.from(imprintsSet)

  const category = pickEnum(GLS_CATEGORIES, source.category, 'Other')

  return {
    title: enforceLength(
      `Custom ${material} ${category} with Your Logo - Bulk Promo ${category}`,
      LIMITS.title
    ),
    summary: ensureRushSuffix(`Promotional ${category.toLowerCase()} with custom logo decoration`),
    description: enforceLength(
      `[AI not configured] Customize this ${material.toLowerCase()} ${category.toLowerCase()} as a branded giveaway for trade shows, employee welcome kits, client appreciation, and seasonal campaigns. Bulk pricing, rush service, and reliable decoration make it a strong fit for promotional programs.\n\nConfigure the API key in the Settings page and regenerate to get a complete English copy and Chinese translation.`,
      LIMITS.description
    ),
    keywords: ['Custom Logo', 'Promotional Product', 'Bulk Giveaway', 'Trade Show', 'Corporate Gift'],
    category,
    typeOfProduct: category,
    categories: [category],
    themes,
    material,
    colors: colorsString,
    colorChips,
    imprintMethods: imprintMethodsFinal,
    imprintArea: estimateToImprintString(estimateImprintArea(source)),
    productionTime: '5-7 business days after proof approval',
    packaging: units.cartonSizeInch
      ? `Carton: ${units.cartonSizeInch}, ${source.pcsPerCarton ?? '?'} pcs/ctn, ${units.cartonGwLb ?? '?'} lb`
      : 'To be confirmed',
    warnings: ['Placeholder content — configure API key and regenerate to get full listing'],
    priceGrid: buildPriceGrid(source, settings).rows,
    productSizeInch: units.productSizeInch,
    productSizeCm: units.productSizeCm,
    unitWeightLb: units.unitWeightLb,
    cartonSizeInch: units.cartonSizeInch,
    cartonGwLb: units.cartonGwLb,
    titleZh: `[占位] 自定义 ${category} - 待 AI 生成`,
    summaryZh: '[占位] 待 AI 生成；末尾会强制包含 Rush service is available',
    descriptionZh: '[占位] 请到「设置」配置 API Key 后重新生成。',
    keywordsZh: '[占位] 自定义 logo, 促销礼品, 贸易展',
    source: 'template',
    generatedAt: new Date().toISOString(),
    qc: {
      titleLen: 0,
      summaryLen: 0,
      descriptionLen: 0,
      keywordCount: 0,
      ok: false,
      issues: ['Skeleton listing — regenerate with AI to populate fields'],
    },
  }
}

function templateListing(source: SourceInfo, settings: Settings): Listing {
  const skeleton = buildSkeletonListing(source, settings)
  return applyQc({ ...skeleton, qc: undefined })
}

function normalizeListing(
  raw: Record<string, unknown>,
  rows: PriceRow[],
  source: SourceInfo,
  settings: Settings
): Listing {
  const units = convertUnits(source)
  const detectedColors = detectColors(source.colorsCn)
  const fallbackColor = detectedColors.length ? detectedColors : ['Black', 'White']

  const themes = ((): string[] => {
    const list = Array.isArray(raw.themes) ? (raw.themes as unknown[]).map((x) => String(x)) : []
    const filtered = list.filter((t) => (ASI_THEMES as readonly string[]).some((x) => x.toLowerCase() === t.toLowerCase()))
    return Array.from(new Set(filtered))
  })()

  const colorsString =
    typeof raw.colors === 'string' && raw.colors.trim()
      ? raw.colors.trim()
      : translateColors(source.colorsCn) || fallbackColor.join('/')

  const colorChips = Array.isArray(raw.colorChips)
    ? (raw.colorChips as unknown[]).map((x) => String(x))
    : colorsString.split('/').map((s) => s.trim()).filter(Boolean)

  const detectedMaterials = detectMaterials(source.materialCn)
  const fallbackMaterial = detectedMaterials[0] || 'Other'

  // Imprint Area：默认留空，由用户在链接生成界面自行填写（之前自动估算与实物偏差大）
  const imprintAreaStr = ''

  const rawCategories = ((): string[] => {
    const list = Array.isArray(raw.categories)
      ? (raw.categories as unknown[]).map((x) => String(x))
      : typeof raw.categories === 'string'
        ? String(raw.categories).split(/[,/]/).map((s) => s.trim())
        : []
    const filtered = list
      .filter((c) => (GLS_CATEGORIES as readonly string[]).some((x) => x.toLowerCase() === c.toLowerCase()))
    return Array.from(new Set(filtered)).slice(0, 2)
  })()
  const primaryCategory = pickEnum(GLS_CATEGORIES, raw.category, source.category)
  const categories = rawCategories.length ? rawCategories : [primaryCategory]

  const listing: Listing = {
    title: String(raw.title ?? '').trim(),
    summary: String(raw.summary ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    keywords: cleanKeywordList(raw.keywords ?? (typeof raw.keywords === 'string' ? raw.keywords : '')),
    category: primaryCategory,
    typeOfProduct: pickEnum(ASI_CATEGORIES, raw.typeOfProduct, primaryCategory),
    categories,
    themes,
    material: pickEnum(ASI_MATERIALS, raw.material, fallbackMaterial),
    materials: (() => {
      // 优先用 AI 返回的 materials 数组；其次从 material 字符串解析；最后用 detectMaterials
      if (Array.isArray(raw.materials)) {
        const allowed = (raw.materials as unknown[])
          .map((x) => String(x))
          .filter((m) => (ASI_MATERIALS as readonly string[]).some((x) => x.toLowerCase() === m.toLowerCase()))
        if (allowed.length) return Array.from(new Set(allowed))
      }
      if (typeof raw.material === 'string' && /[,/]/.test(raw.material)) {
        const parts = raw.material
          .split(/[,/]/)
          .map((s: string) => s.trim())
          .filter(Boolean)
          .map((m: string) => pickEnum(ASI_MATERIALS, m, ''))
          .filter(Boolean)
        if (parts.length) return Array.from(new Set(parts))
      }
      return detectedMaterials
    })(),
    colors: colorsString,
    colorChips,
    imprintMethods: pickEnumMany(ASI_IMPRINT_METHODS, raw.imprintMethods ?? settings.defaultImprintMethods),
    imprintArea: imprintAreaStr,
    productionTime: String(raw.productionTime ?? '5-7 business days after proof approval').trim(),
    packaging: String(raw.packaging ?? '').trim() || (units.cartonSizeInch ? `Carton: ${units.cartonSizeInch}, ${source.pcsPerCarton ?? '?'} pcs/ctn, ${units.cartonGwLb ?? '?'} lb` : 'To be confirmed'),
    warnings: arr(raw.warnings),
    priceGrid: rows,
    productSizeInch: units.productSizeInch,
    productSizeCm: units.productSizeCm,
    unitWeightLb: units.unitWeightLb,
    cartonSizeInch: units.cartonSizeInch,
    cartonGwLb: units.cartonGwLb,
    titleZh: String(raw.titleZh ?? '').trim(),
    summaryZh: String(raw.summaryZh ?? '').trim(),
    descriptionZh: String(raw.descriptionZh ?? '').trim(),
    keywordsZh: String(raw.keywordsZh ?? '').trim(),
    generatedAt: new Date().toISOString(),
    source: 'ai',
  }
  return listing
}

export async function generateListing(
  source: SourceInfo,
  settings: Settings,
  answers?: ListingAnswer[],
  similar?: SimilarResearch | null
): Promise<Listing> {
  const { rows } = buildPriceGrid(source, settings)
  if (!settings.aiApiKey?.trim()) return templateListing(source, settings)
  const { system, user } = buildListingPrompt(source, settings, answers, similar)
  const images = (source.images ?? []).slice(0, 4)
  const raw = await callChatJson<Record<string, unknown>>(settings, system, user, 0.5, images)
  const listing = normalizeListing(raw, rows, source, settings)
  return applyQc(listing)
}

export async function generateListingQuestions(
  source: SourceInfo,
  settings: Settings
): Promise<{ id: string; question: string; placeholder: string; hint?: string }[]> {
  if (!settings.aiApiKey?.trim()) {
    // 无 AI 时返回固定的 4 个兜底问题
    return [
      {
        id: 'target_buyer',
        question: '这个产品最想卖给哪些客户？',
        placeholder: '例如：500 强企业 HR 部门 / 大学书店 / 户外品牌社群 / 礼品公司',
      },
      {
        id: 'key_benefit',
        question: '这个产品相比 1688 上同款最突出的 1-2 个卖点是什么？',
        placeholder: '例如：304 不锈钢、可激光雕刻 logo、12 种颜色、24h 出样',
      },
      {
        id: 'imprint_pref',
        question: '客户最常做的印刷方式与最大印刷面积是多少？',
        placeholder: '例如：丝印，单面最大 4×4 cm / 激光雕刻，整圈环绕',
      },
      {
        id: 'packaging',
        question: '默认包装方式是什么？',
        placeholder: '例如：白盒 / 彩盒 / opp 袋 / 彩卡',
      },
    ]
  }
  const { system, user } = buildListingQuestionsPrompt(source)
  const raw = await callChatJson<{ questions?: unknown }>(settings, system, user, 0.4)
  const list = Array.isArray(raw.questions) ? (raw.questions as unknown[]) : []
  const out: Array<{ id: string; question: string; placeholder: string; hint?: string }> = []
  for (const q of list) {
    if (!q || typeof q !== 'object') continue
    const o = q as Record<string, unknown>
    const id = String(o.id ?? '').trim()
    const question = String(o.question ?? '').trim()
    const placeholder = String(o.placeholder ?? '').trim()
    const hint = typeof o.hint === 'string' ? o.hint.trim() : undefined
    if (!id || !question) continue
    const item: { id: string; question: string; placeholder: string; hint?: string } = {
      id,
      question,
      placeholder,
    }
    if (hint) item.hint = hint
    out.push(item)
  }
  return out
}

/** 把 AI 看图找类似的输出规整为 SimilarResearch；无 AI 时返回空结构 */
function normalizeSimilar(raw: Record<string, unknown> | null | undefined): SimilarResearch {
  const r = (raw ?? {}) as Record<string, unknown>
  const pickItems = (v: unknown): SimilarResearch['amazonItems'] => {
    if (!Array.isArray(v)) return []
    return (v as unknown[])
      .map((it) => {
        if (it && typeof it === 'object') {
          const o = it as Record<string, unknown>
          return {
            title: String(o.title ?? '').trim(),
            asin: typeof o.asin === 'string' ? o.asin.trim() : undefined,
            priceUsd: typeof o.priceUsd === 'number' ? o.priceUsd : null,
            url: typeof o.url === 'string' ? o.url.trim() : undefined,
            note: typeof o.note === 'string' ? o.note.trim() : undefined,
          }
        }
        return null
      })
      .filter((x): x is NonNullable<typeof x> => !!x && !!x.title)
  }
  const price = (r.priceRangeUsd ?? {}) as Record<string, unknown>
  return {
    productType: typeof r.productType === 'string' ? r.productType.trim() : undefined,
    visualFeatures: arr(r.visualFeatures),
    categoryGuess: typeof r.categoryGuess === 'string' ? r.categoryGuess.trim() : undefined,
    amazonItems: pickItems(r.amazonItems),
    asiItems: pickItems(r.asiItems) as SimilarResearch['asiItems'],
    // 方案 A：保留流量词 / ASIN / 竞品品牌，供关键词生成注入
    amazonSearchTerms: arr(r.amazonSearchTerms),
    asiSearchTerms: arr(r.asiSearchTerms),
    likelyAsins: arr(r.likelyAsins),
    competingBrands: arr(r.competingBrands),
    suggestions: arr(r.suggestions),
    referenceTitles: arr(r.referenceTitles),
    priceRangeUsd: {
      min: typeof price.min === 'number' ? price.min : null,
      max: typeof price.max === 'number' ? price.max : null,
    },
    generatedAt: new Date().toISOString(),
  }
}

/** 无 AI 时的类似商品兜底（提示业务侧按这些关键词去 asinseed.com / Amazon / ASI 自查） */
function templateSimilar(source: SourceInfo): SimilarResearch {
  const productType = source.sourceTitle?.split(/[,，\s]/)[0]?.slice(0, 30) || 'Promo Product'
  return {
    productType,
    visualFeatures: [],
    categoryGuess: source.category || undefined,
    amazonItems: [],
    asiItems: [],
    suggestions: [
      '配置 AI Key 后调用「看图找类似」，可获得亚马逊/ASI 同款候选与 ASIN',
      `去 asinseed.com 输入同款 ASIN，查该 ASIN 的高频词补到关键词前 20 个`,
      `在 Amazon US 用 "${productType} promotional" / "${productType} bulk" 搜，记下前 10 条标题模板`,
      `在 ASI/PPAI 官网用 "${productType}" 搜，记下前 10 条分销商标题与价位`,
    ],
    referenceTitles: [],
    generatedAt: new Date().toISOString(),
  }
}

export async function findSimilarForSource(source: SourceInfo, settings: Settings): Promise<SimilarResearch> {
  if (!settings.aiApiKey?.trim()) return templateSimilar(source)
  const { system, user } = buildFindSimilarPrompt(source)
  const images = (source.images ?? []).slice(0, 4)
  const raw = await callChatJson<Record<string, unknown>>(settings, system, user, 0.4, images)
  return normalizeSimilar(raw)
}

// ---------- AI 助手对话窗口（免提问，自动补全信息） ----------

export interface AssistantResult {
  /** 中文自然语言回复 */
  reply: string
  /** 可选的 Listing 字段补丁（前端直接合并进表单） */
  patch: Record<string, unknown> | null
  /** 警告/提示 */
  notes: string[]
}

export async function assistantChat(
  source: SourceInfo,
  listing: Partial<Listing> | null,
  messages: ChatMessage[],
  settings: Settings,
  /** 分区对话模式：只允许讨论/修改这些 listing 字段 */
  scopeFields?: string[]
): Promise<AssistantResult> {
  const { system, user } = buildAssistantPrompt(source, listing, messages, scopeFields)
  const raw = await callChatJson<Record<string, unknown>>(settings, system, user, 0.6)
  const patchRaw = raw.patch
  const patch =
    patchRaw && typeof patchRaw === 'object' && !Array.isArray(patchRaw)
      ? (patchRaw as Record<string, unknown>)
      : null
  return {
    reply: String(raw.reply ?? '').trim() || '（AI 未返回内容，请重试）',
    patch,
    notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
  }
}

// ---------- 分块重新生成（每个区块可单独 AI 重生成，不影响其他区块） ----------

/** 数组型字段（重生成后按数组规范化） */
const ARRAY_REGEN_FIELDS = new Set([
  'keywords',
  'themes',
  'categories',
  'materials',
  'imprintMethods',
  'warnings',
  'colorChips',
])

/**
 * 只重生成 listing 的指定字段（一个区块），返回 { 字段: 新值 } 补丁。
 * 不落库、不改动其他字段；由前端合并后让用户确认保存。
 */
export async function regenerateListingFields(
  source: SourceInfo,
  listing: Partial<Listing> | null,
  fields: string[],
  instruction: string | undefined,
  settings: Settings
): Promise<Record<string, unknown>> {
  const { system, user } = buildFieldsRegeneratePrompt(source, listing, fields, instruction)
  const raw = await callChatJson<Record<string, unknown>>(settings, system, user, 0.6)
  // 兼容平铺与 {"value": {...}} 包裹两种返回
  const src = (
    raw.value && typeof raw.value === 'object' && !Array.isArray(raw.value) ? raw.value : raw
  ) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    if (!(f in src)) continue
    const v = src[f]
    if (ARRAY_REGEN_FIELDS.has(f)) {
      const list = Array.isArray(v)
        ? v.map((x) => String(x).trim()).filter(Boolean)
        : String(v ?? '')
            .split(/[,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean)
      out[f] = Array.from(new Set(list))
    } else {
      out[f] = String(v ?? '').trim()
    }
  }
  if (Object.keys(out).length === 0) {
    throw new AiError('AI 未返回任何字段值，请重试')
  }
  return out
}

// ---------- 1688 选品自动搜寻 ----------

export interface SourcingDirection {
  product: string
  why: string
  search1688: string[]
  category: string
  expectedUnitCostCny: number | null
  expectedSellUsd: { min: number; max: number } | null
  risks: string[]
}

export interface SourcingResult {
  directions: SourcingDirection[]
  keywords1688: string[]
  tips: string[]
}

export async function suggestSourcing(
  input: {
    category?: string
    keywords?: string
    budgetCny?: number | null
    targetPriceUsd?: { min: number; max: number } | null
    notes?: string
  },
  settings: Settings
): Promise<SourcingResult> {
  const { system, user } = buildSourcingPrompt(input)
  const raw = await callChatJson<Record<string, unknown>>(settings, system, user, 0.7)
  const dirs: SourcingDirection[] = Array.isArray(raw.directions)
    ? (raw.directions as unknown[])
        .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
        .map((d) => ({
          product: String(d.product ?? '').trim(),
          why: String(d.why ?? '').trim(),
          search1688: Array.isArray(d.search1688) ? d.search1688.map(String) : [],
          category: String(d.category ?? '').trim(),
          expectedUnitCostCny: typeof d.expectedUnitCostCny === 'number' ? d.expectedUnitCostCny : null,
          expectedSellUsd:
            d.expectedSellUsd && typeof d.expectedSellUsd === 'object'
              ? {
                  min: Number((d.expectedSellUsd as Record<string, unknown>).min) || 0,
                  max: Number((d.expectedSellUsd as Record<string, unknown>).max) || 0,
                }
              : null,
          risks: Array.isArray(d.risks) ? d.risks.map(String) : [],
        }))
        .filter((d) => d.product)
    : []
  return {
    directions: dirs,
    keywords1688: Array.isArray(raw.keywords1688) ? raw.keywords1688.map(String) : [],
    tips: Array.isArray(raw.tips) ? raw.tips.map(String) : [],
  }
}

// ---------- 深度选品研究（对标 4imprint 热销 → AI 分析 → 1688 找同款） ----------

export interface ResearchAsiProduct {
  name: string
  url: string
  image: string
  priceFrom: number | null
  priceTo: number | null
  rating: number | null
  category: string
  orderMin: string
  shipDays: string
}

export interface ResearchMatch {
  url: string
  title: string
  priceCny: number | null
  image: string
  moq: number | null
}

export interface ResearchDirection {
  asiProduct: { name: string; url: string }
  why: string
  features: string[]
  search1688: string[]
  expectedUnitCostCny: number | null
  expectedSellUsd: { min: number; max: number } | null
  risks: string[]
  matches: ResearchMatch[]
}

export interface ResearchResult {
  ok: boolean
  query: string
  queryEn: string
  asiProducts: ResearchAsiProduct[]
  directions: ResearchDirection[]
  tips: string[]
}

/** AI 分析 4imprint 热销产品：挑选对标品 + 分析卖点 + 生成 1688 中文搜索词 */
export async function researchSourcing(
  input: {
    category?: string
    keywords?: string
    budgetCny?: number | null
    notes?: string
    asiProducts: ResearchAsiProduct[]
  },
  settings: Settings
): Promise<{ directions: ResearchDirection[]; tips: string[] }> {
  const { system, user } = buildSourcingResearchPrompt({
    category: input.category,
    keywords: input.keywords,
    budgetCny: input.budgetCny,
    notes: input.notes,
    asiProducts: input.asiProducts.map((p) => ({
      name: p.name,
      url: p.url,
      priceFrom: p.priceFrom,
      priceTo: p.priceTo,
      rating: p.rating,
      category: p.category,
      orderMin: p.orderMin,
    })),
  })
  const raw = await callChatJson<Record<string, unknown>>(settings, system, user, 0.5)
  const byName = new Map(input.asiProducts.map((p) => [p.name.toLowerCase(), p]))
  const dirs: ResearchDirection[] = Array.isArray(raw.directions)
    ? (raw.directions as unknown[])
        .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
        .map((d) => {
          const ap = (d.asiProduct ?? {}) as Record<string, unknown>
          const name = String(ap.name ?? '').trim()
          // 名称必须能对回 4imprint 列表（防止 AI 编造产品），对不回则取 url 匹配或丢弃
          const hit = byName.get(name.toLowerCase())
          return {
            asiProduct: { name: hit?.name ?? name, url: String(ap.url ?? hit?.url ?? '').trim() },
            why: String(d.why ?? '').trim(),
            features: Array.isArray(d.features) ? d.features.map(String).filter(Boolean) : [],
            search1688: Array.isArray(d.search1688) ? d.search1688.map(String).map((s) => s.trim()).filter(Boolean) : [],
            expectedUnitCostCny: typeof d.expectedUnitCostCny === 'number' ? d.expectedUnitCostCny : null,
            expectedSellUsd:
              d.expectedSellUsd && typeof d.expectedSellUsd === 'object'
                ? {
                    min: Number((d.expectedSellUsd as Record<string, unknown>).min) || 0,
                    max: Number((d.expectedSellUsd as Record<string, unknown>).max) || 0,
                  }
                : null,
            risks: Array.isArray(d.risks) ? d.risks.map(String) : [],
            matches: [] as ResearchMatch[],
          }
        })
        .filter((d) => d.asiProduct.name && d.search1688.length > 0)
    : []
  return {
    directions: dirs,
    tips: Array.isArray(raw.tips) ? raw.tips.map(String).filter(Boolean) : [],
  }
}

/** AI 把中文类目/关键词翻译成 4imprint 英文搜索词（4imprint 只支持英文搜索） */
export async function researchQueryEn(text: string, settings: Settings): Promise<string> {
  const system = `Translate a Chinese product category/keyword into ONE short English search query for 4imprint.com (a US promotional products site).
Respond with STRICT JSON only: { "query": "<English search query, 1-3 words, e.g. canvas tote bag>" }`
  const raw = await callChatJson<Record<string, unknown>>(settings, system, `Chinese: ${text}`, 0.3)
  return String(raw.query ?? '').trim()
}
