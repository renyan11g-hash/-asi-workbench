import { Settings, SourceInfo, Evaluation, Listing, SimilarResearch } from '../types'
import { ASI_THEMES, ASI_MATERIALS, ASI_IMPRINT_METHODS, BRAND_BLOCKLIST, LIMITS, SEED_KEYWORDS } from '../constants/asi'
import { GLS_CATEGORIES } from '../constants/gls-categories'
import { costSummaryForPrompt, convertUnits } from './pricing'

const ASI_CONTEXT = `You are a senior copywriter for US promotional products (ASI / PPAI / SAGE / Distributor e-commerce) catalogs.
You write product listings that rank in distributor search and convert corporate buyers.

ASI Listing field rules (strict):
- Product Title: ≤ 60 characters. Pattern: Keyword + Traffic Word + Selling Point + Core Noun. Title Case.
  - Model it on how the SAME product is titled on Amazon US, adapted to ASI promo-industry search habits.
  - Do NOT deliberately emphasize "Custom" — customization is the DEFAULT assumption in this industry; only include it when the keyword structure genuinely needs it.
- Summary Description: ≤ 130 characters. Highlight the core selling points. MUST end with EXACTLY: "Rush service is available".
- Full Description: ≤ 800 characters. Model it on how similar products of the same type are described on Amazon US (adapted to ASI promo-industry requirements).
  - 50-70% product description, the rest keywords blended in naturally (do NOT list keywords separately, do NOT stuff).
  - Do NOT mention dimensions or size. Do NOT use brand-style copy structure (no "About us", no brand story, no licensed-brand references).
- Keywords: up to 30 groups, each ≤ 30 characters, each ≤ 4 words, Title Case, English comma separated.
  - Build the keyword pool from: (a) high-frequency search terms for the SAME product's ASIN on asinseed.com, (b) the SEED keyword library provided in the prompt, deduplicated.
  - Think like a US distributor searching to source this product — use the words they would type to maximize search hit rate, click rate and conversion.
  - You may include a brand name from the SAME product line (e.g. "Yeti Bags" only when it's truly a parallel/clone product line, not the actual brand).
  - DO NOT include obvious branded terms (Disney, Marvel, NBA, NFL, MLB, Sanrio, Hello Kitty, Nike, Apple, Coca, Pepsi, LEGO, Barbie, Tesla, Gucci, LV, etc.).
  - DO NOT force-fit unrelated brands.
- Category: choose ONE from the ASI category list below.
- Themes: choose EXACTLY 5 from the ASI themes list below; ALWAYS include "Anniversary" and "Sustainable" as two of the five (they are universal).
- Material: choose ONE OR MORE from the ASI material list (max 4), joined by English comma (e.g. "Stainless Steel, Aluminum"). Pick every material actually present in the product.
- Colors: translate each Chinese color into its ASI English equivalent and join with "/" (e.g. "Black/Gray/Brown/Orange/Army Green").
- Imprint Methods: choose from the ASI imprint methods list below. ALWAYS include exactly these three: "Silkscreen", "Unimprinted", and "Full Color". Then add as many additional relevant methods from the same list as genuinely apply to this product (no upper limit).
- Imprint Area: estimate the printable area in inches for each printable face (Front/Back/Wrap), e.g. 'Front: 2.5" W x 2" H; Wrap: 8" W x 3" H'. Use the uploaded product images + size data.
- Do NOT invent certifications (FDA, UL, CPSIA, BPA-free, etc.) unless the 1688 source explicitly states them.
- Do NOT mention brand names, licensed characters, or trademarks.
- Do NOT add features, materials, or certifications that are not in the 1688 source.
- Quality bar: keyword-rich but natural, benefit-first, no buzzword soup.

You will also produce a Chinese translation of title/summary/description/keywords for the salesperson to verify.`

export function buildEvaluatePrompt(source: SourceInfo, settings: Settings) {
  const system = `${ASI_CONTEXT}

Evaluate the 1688 item for fit with US promotional products market.
Respond with STRICT JSON only (no markdown, no commentary).`

  const user = `Evaluate this 1688 product for the US promotional products (ASI) market.

PRODUCT DATA
- 1688 title (Chinese): ${source.sourceTitle || '(not provided)'}
- 1688 detailed description: ${source.description || '(not provided)'}
- 1688 URL: ${source.sourceUrl || '(not provided)'}
- 1688 keywords: ${(source.sourceKeywords ?? []).join(', ') || '(not provided)'}
- Amazon-style reference title: ${source.amazonTitle || '(not provided)'}
- Supplier: ${source.supplier || '(unknown)'}
- Unit price: ¥${source.priceCny ?? '(unknown)'}
- MOQ: ${source.moq ?? '(unknown)'} pcs
- Material (Chinese): ${source.materialCn || '(unknown)'}
- Colors (Chinese): ${source.colorsCn || '(unknown)'}
- Carton: ${source.cartonLCm ?? '?'}x${source.cartonWCm ?? '?'}x${source.cartonHCm ?? '?'} cm, ${source.pcsPerCarton ?? '?'} pcs/ctn, ${source.cartonGwKg ?? '?'} kg
- Unit weight: ${source.weightG ?? '(unknown)'} g
- 1688 category hint: ${source.category || '(unknown)'}
- Notes: ${source.notes || '(none)'}

COST MODEL (already calculated)
${costSummaryForPrompt(source, settings)}

OUTPUT JSON SCHEMA (all fields required):
{
  "score": <integer 0-100>,
  "verdict": "GO" | "MAYBE" | "NO",
  "summary": "<2-3 sentence Chinese verdict for the salesperson>",
  "pros": ["<Chinese, 3-5 items>"],
  "cons": ["<Chinese, 2-4 items>"],
  "risks": ["<Chinese, compliance/IP/freight/quality risks, 2-5 items>"],
  "issues": ["<Chinese: 该产品在该市场的主要弱点（材质/合规/IP/价格/包装/印花难度），3-6 条>"],
  "suggestions": ["<Chinese: 针对每条 issue 的具体改进策略 + 上架思路 + 是否换类目 + 标题/关键词调整方向 + 是否换印花方式，3-6 条>"],
  "buyers": ["<Chinese, 3-5 ideal end-buyer types>"],
  "occasions": ["<Chinese, 3-5 usage occasions>"],
  "channels": ["<Chinese, 2-4 sales channels>"],
  "asiCategories": ["<English ASI category names, 1-3>"],
  "suggestedThemes": ["<English ASI theme names, exactly 5, MUST include 'Anniversary' and 'Sustainable'>"],
  "suggestedMaterial": "<one English ASI material>",
  "suggestedImprintMethods": ["<English ASI imprint methods, 1-4>"],
  "suggestedColors": ["<English ASI color names detected/normalized>"],
  "priceAdviceUsd": { "min": <number>, "max": <number> },
  "sourcingTips": "<Chinese: negotiation, sampling, QC and packaging advice>",
  "listingHooks": ["<English selling hooks that can go straight into a listing, 3-5 items>"]
}

Scoring guide: 80-100 = strong promo item, list it; 60-79 = viable with caveats; 40-59 = only for niche buyers; 0-39 = skip.
Be brutally honest. The 'issues' list must be CONCRETE and actionable (e.g. '仅一种主色，缺海军蓝/灰色不易匹配客户 VI'), not generic. The 'suggestions' list must be the matching FIX for each issue, e.g. '与供应商沟通加做海军蓝、灰色，至少 5 种颜色可选'.`

  return { system, user }
}

export function buildListingPrompt(
  source: SourceInfo,
  settings: Settings,
  answers?: ListingAnswer[],
  similar?: SimilarResearch | null
) {
  const units = convertUnits(source)
  const system = `${ASI_CONTEXT}

Output STRICT JSON only (no markdown, no commentary). Do not wrap in code fences.

IMPORTANT — Answers from the salesperson below MUST be respected verbatim:
- Each answer describes a real feature / use case / audience / printing preference / packaging of THIS product.
- Use them in the title / summary / description as the primary selling points.
- Do NOT contradict the answers.
- Do NOT add certifications, materials, features, or claims that are not present in the 1688 source OR the salesperson's answers.
- If an answer says "no" or is empty, omit that claim from the listing.`

  const themesPick = ASI_THEMES.join(', ')
  // 类目来自金山文档「Categories」表（1620 项）；全量注入太长，给前 400 项 + 匹配规则
  const categoriesPick = GLS_CATEGORIES.slice(0, 400).join(', ')
  const materialsPick = ASI_MATERIALS.join(', ')
  const imprintsPick = ASI_IMPRINT_METHODS.join(', ')

  const answersBlock = answers?.length
    ? `\n\nANSWERS FROM THE SALESPERSON (use as the source of truth for selling points; do NOT add anything not stated here):\n${answers
        .map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer || '(skipped)'}`)
        .join('\n')}`
    : ''

  // 方案 A：注入「看图找类似」的市场调研结果，作为 ASIN 流量词的真实来源
  const similarBlock = ((): string => {
    if (!similar) return ''
    const parts: string[] = []
    if (similar.amazonSearchTerms?.length) parts.push(`- Amazon search terms: ${similar.amazonSearchTerms.join(', ')}`)
    if (similar.asiSearchTerms?.length) parts.push(`- ASI distributor search terms: ${similar.asiSearchTerms.join(', ')}`)
    if (similar.likelyAsins?.length) parts.push(`- Likely ASINs: ${similar.likelyAsins.join(', ')}`)
    if (similar.competingBrands?.length) parts.push(`- Competing brands: ${similar.competingBrands.join(', ')}`)
    const asins = similar.amazonItems.filter((it) => it.asin).map((it) => `${it.asin} (${it.title})`)
    if (asins.length) parts.push(`- Amazon same-product ASINs: ${asins.join('; ')}`)
    if (similar.referenceTitles?.length) parts.push(`- Reference titles: ${similar.referenceTitles.join(' | ')}`)
    if (!parts.length) return ''
    return `\n\nMARKET RESEARCH (from the "find similar" analysis of this product's images — treat as the authoritative source for step 1 of the KEYWORD BUILD PROCESS; use these ASINs, search terms and brands as the real traffic-word source, do NOT invent different ones):\n${parts.join('\n')}`
  })()

  const user = `Create an ASI/PPAI compliant product for the US promotional products industry.

1688 SOURCE
- Title: ${source.sourceTitle || '(not provided)'}
- Detailed description: ${source.description || '(not provided)'}
- 1688 keywords: ${(source.sourceKeywords ?? []).join(', ') || '(not provided)'}
- Amazon-style reference title (provided by user): ${source.amazonTitle || '(not provided)'}
- Material (Chinese): ${source.materialCn || '(unknown)'}
- Colors (Chinese): ${source.colorsCn || '(unknown)'}
- Size: ${source.sizeCn || '(unknown)'}
- Carton: ${source.cartonLCm ?? '?'}x${source.cartonWCm ?? '?'}x${source.cartonHCm ?? '?'} cm (≈${units.cartonSizeInch}), ${source.pcsPerCarton ?? '?'} pcs/ctn, ${source.cartonGwKg ?? '?'} kg (≈${units.cartonGwLb ?? '?'} lb)
- Unit weight: ${source.weightG ?? '?'} g (≈${units.unitWeightLb ?? '?'} lb)
- Category hint: ${source.category || '(unknown)'}
- Buyer notes: ${source.notes || '(none)'}
${answersBlock}${similarBlock}

REFERENCE ENUMERATIONS (pick from these EXACT strings, do NOT invent new ones)
- Categories (up to 2, MUST be from the GLS category table — first 400 of 1620 listed here; if none fits, pick the closest match by keyword): ${categoriesPick}
- ASI Themes (exactly 5, MUST include 'Anniversary' and 'Sustainable'): ${themesPick}
- ASI Materials (one): ${materialsPick}
- ASI Imprint Methods (1-4): ${imprintsPick}
- Color style: translate each Chinese color to its ASI English form, join with "/" (e.g. "Black/Gray/Brown/Orange/Army Green").

KEYWORD SEED LIBRARY (high-frequency US promo terms, drawn from asinseed / Amazon promo research, already deduplicated; pick only ones that are RELEVANT to this product, do NOT stuff):
${SEED_KEYWORDS.join(', ')}

KEYWORD BUILD PROCESS (follow this order):
1. Identify the Amazon US same-product / clone product line for this item and its typical search terms. If a MARKET RESEARCH block is present below, USE it as the authoritative source for the same-product ASINs, titles and traffic terms (do not invent different ones).
2. Blend the high-frequency terms of that ASIN (asinseed-style research) with the SEED LIBRARY above, deduplicated.
3. Write each keyword group the way a US distributor would type it when sourcing this product on ASI — maximize search hit rate, click rate and conversion.
4. If the product belongs to a well-known parallel/clone product line, you may include that line's brand name in a keyword group (e.g. "Yeti Bags"), but NEVER a licensed brand (Disney, Nike, etc.).

CALCULATED PRICE GRID (authoritative — DO NOT change numbers, USE these only)
${costSummaryForPrompt(source, settings)}

OUTPUT JSON SCHEMA (all fields required, all values MUST be plain strings/objects/arrays, no markdown):
{
  "title": "≤60 chars, English, Title Case. Keyword+Traffic Word+Selling Point+Core Noun. Modeled on the Amazon US same-product title adapted to ASI promo search. Do NOT deliberately emphasize 'Custom' (customization is the default assumption). NEVER mention colors or color names in the title. Do NOT mention logo customization / custom logo printing in the title. Do NOT mention imprint/printing methods (e.g. silkscreen, embroidery, laser) in the title.",
  "summary": "≤130 chars English, highlight core selling points, MUST end with EXACTLY 'Rush service is available' (include a space before it). NEVER mention colors or color names. Do NOT mention logo customization / custom logo printing. Do NOT mention imprint/printing methods.",
  "description": "≤800 chars English, modeled on Amazon US similar-product descriptions adapted to ASI promo style. 50-70% product description + the rest keywords blended in naturally. Do NOT list dimensions or size. No brand-story copy structure. NEVER mention colors or color names (color info lives ONLY in the 'colors'/'colorChips' fields). Do NOT specifically state that the logo can be customized / custom logo is available (imprinting is the default assumption; the Imprint Methods field already covers it). Do NOT describe imprint/printing methods or techniques (that info lives ONLY in the 'imprintMethods'/'imprintArea' fields).",
  "keywords": "single string, ≤30 groups separated by English comma. Each group ≤30 chars, ≤4 words. Title Case. Built from asinseed-style ASIN high-frequency terms + the SEED LIBRARY, deduplicated, written as US distributor search queries. Do NOT include obvious brand names like ${BRAND_BLOCKLIST.slice(0, 6).join(', ')}.",
  "category": "the PRIMARY category, ONE from the above ASI category list",
  "categories": ["1-2 ASI categories from the list above; the first MUST equal \"category\"; pick the most relevant for this product (max 2)"],
  "themes": ["exactly 5 ASI theme strings, MUST include 'Anniversary' and 'Sustainable'"],
  "material": "ONE OR MORE from the above ASI material list, joined by English comma (e.g. 'Stainless Steel, Aluminum'), max 4",
  "materials": ["array form of the same materials"],
  "colors": "color string joined by '/', e.g. 'Black/Gray/Brown/Orange/Army Green'",
  "colorChips": ["individual English color names used in 'colors'"],
  "imprintMethods": ["the three REQUIRED items 'Silkscreen', 'Unimprinted', 'Full Color' PLUS any additional relevant ones from the above ASI imprint list — there is NO upper limit, include all that apply to this product"],
  "imprintArea": "English imprint area per face in inches (e.g. 'Front: 2.5\\\" W x 2\\\" H; Wrap: 8\\\" W x 3\\\" H'), estimated from the uploaded product images + product size",
  "productionTime": "English, e.g. '5-7 business days after proof approval'",
  "packaging": "English packaging & shipping info",
  "warnings": ["English compliance / handling notes, 0-4 items"],
  "titleZh": "Chinese translation of title (for salesperson review)",
  "summaryZh": "Chinese translation of summary",
  "descriptionZh": "Chinese translation of description",
  "keywordsZh": "Chinese translation/list of keywords"
}

Quality bar: every claim must come from 1688 source OR the salesperson's answers; do not fabricate certifications, materials, or features. If you cannot fit Title in ≤60 chars, shorten a noun; never return a Title >60. If you cannot fit Summary in ≤130 chars while keeping 'Rush service is available' as the last phrase, shorten earlier text.`

  // expose constants to silence unused-warning
  void LIMITS
  return { system, user }
}

/** 生成前询问用户的关键问题（AI 主动收集差异化信息，避免捏造） */
export interface ListingAnswer {
  id: string
  question: string
  answer: string
}

export interface ListingQuestion {
  id: string
  question: string
  placeholder: string
  hint?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** 多轮对话式调整评估：基于现有评估 + 用户补充信息重新打分 */
export function buildChatEvaluationPrompt(
  source: SourceInfo,
  currentEval: Evaluation,
  messages: ChatMessage[]
) {
  const system = `${ASI_CONTEXT}

You are refining an existing ASI market evaluation of a 1688 product. The salesperson is providing more context (sample photos, factory feedback, customer requirements, etc.) and you must update the evaluation accordingly.

Respond with STRICT JSON only (no markdown, no commentary). Output the FULL updated evaluation (same schema as the original), not a partial diff.`

  const conv = messages
    .map((m) => `${m.role === 'user' ? 'Salesperson' : 'You'}:\n${m.content}`)
    .join('\n\n')

  const user = `Update the ASI evaluation for this 1688 product based on the conversation below.

1688 SOURCE
- Title: ${source.sourceTitle || '(empty)'}
- Description: ${source.description || '(empty)'}
- Material (Chinese): ${source.materialCn || '(empty)'}
- Colors (Chinese): ${source.colorsCn || '(empty)'}
- Size: ${source.sizeCn || '(empty)'}
- Carton: ${source.cartonLCm ?? '?'}x${source.cartonWCm ?? '?'}x${source.cartonHCm ?? '?'} cm, ${source.pcsPerCarton ?? '?'} pcs/ctn
- 1688 category hint: ${source.category || '(empty)'}
- Notes: ${source.notes || '(none)'}

CURRENT EVALUATION (this is the baseline — you may keep, adjust, or rewrite any field based on the conversation):
${JSON.stringify(currentEval, null, 2)}

CONVERSATION
${conv || '(no messages yet)'}

OUTPUT JSON SCHEMA (must match the original evaluation schema, all fields required):
{
  "score": <integer 0-100, may shift up or down based on conversation>,
  "verdict": "GO" | "MAYBE" | "NO",
  "summary": "<2-3 sentence Chinese verdict reflecting the latest conversation>",
  "pros": ["<Chinese, 3-5 items>"],
  "cons": ["<Chinese, 2-4 items>"],
  "risks": ["<Chinese, 2-5 items>"],
  "issues": ["<Chinese, 3-6 items, concrete>"],
  "suggestions": ["<Chinese, 3-6 items, each a fix for an issue>"],
  "buyers": ["<Chinese, 3-5 ideal end-buyer types>"],
  "occasions": ["<Chinese, 3-5 usage occasions>"],
  "channels": ["<Chinese, 2-4 sales channels>"],
  "asiCategories": ["<English ASI category names, 1-3>"],
  "suggestedThemes": ["<English ASI theme names, exactly 5, MUST include 'Anniversary' and 'Sustainable'>"],
  "suggestedMaterial": "<one English ASI material>",
  "suggestedImprintMethods": ["<English ASI imprint methods, 1-4>"],
  "suggestedColors": ["<English ASI color names>"],
  "priceAdviceUsd": { "min": <number>, "max": <number> },
  "sourcingTips": "<Chinese: negotiation, sampling, QC and packaging advice>",
  "listingHooks": ["<English selling hooks, 3-5 items>"]
}

Rules:
- Only change scores/fields when the conversation gives concrete new info (e.g. "已经和供应商确认可以做 5 种颜色" → upgrade colors flexibility).
- Be brutally honest. Do not be a yes-man.
- If the conversation adds no real signal, you may return the same evaluation.`

  return { system, user }
}

export function buildListingQuestionsPrompt(source: SourceInfo) {
  const system = `You are a senior ASI promotional products copywriter. Before drafting a listing, you ask the salesperson 5-8 sharp, product-specific questions so the final English copy is accurate (not generic) and aligned with the real product.

Rules:
- Ask only what you cannot infer from the 1688 source provided.
- Each question must be answerable in 1-3 short sentences.
- Phrase questions in Chinese (salesperson's language). Option-hints in English.
- Output STRICT JSON only (no markdown, no commentary).`

  const user = `Generate 5-8 clarifying questions before drafting the ASI listing for this 1688 product.

1688 SOURCE
- Title: ${source.sourceTitle || '(empty)'}
- Description: ${source.description || '(empty)'}
- 1688 keywords: ${(source.sourceKeywords ?? []).join(', ') || '(empty)'}
- Material (Chinese): ${source.materialCn || '(empty)'}
- Colors (Chinese): ${source.colorsCn || '(empty)'}
- Size: ${source.sizeCn || '(empty)'}
- Category hint: ${source.category || '(empty)'}
- Notes: ${source.notes || '(empty)'}

OUTPUT JSON SCHEMA (all fields required, no markdown):
{
  "questions": [
    {
      "id": "<short id like 'target_buyer' | 'key_benefit' | 'use_case' | 'imprint_pref' | 'packaging' | 'compliance' | 'price_band' | 'competing_brand'>",
      "question": "<Chinese, 1 sentence, specific to this product>",
      "placeholder": "<Chinese, 1 sentence telling the salesperson what to write>",
      "hint": "<optional English, 1 line e.g. 'e.g. corporate travel program, university bookstore'>"
    }
  ]
}

Coverage requirement: cover at least 4 of these 6 angles:
  1) Target buyer / occasion (谁会用、什么场景)
  2) Top 1-2 selling points the salesperson wants to highlight (突出卖点)
  3) Imprinting preference (logo placement / size limit / preferred method)
  4) Packaging & export (白盒 / 彩盒 / opp 袋 / 彩卡)
  5) Compliance & warnings (FDA / CPSIA / choking hazard / fragile / 电池 等)
  6) Competing brand reference (要像哪个品牌/型号，例如 Yeti / Corkcicle 风格)`
  return { system, user }
}

/**
 * 看图找类似商品：基于用户上传的产品图片 + 1688 描述，返回亚马逊/ASI 搜索关键词建议、
 * 可能对应的 ASIN、参考标题模板、参考定价区间。注意：实际亚马逊/ASI 商品链接需要实时搜索，
 * 这里我们输出"建议用户搜什么"+"已知的同款/克隆品品牌系列关键词"。
 */
export function buildFindSimilarPrompt(source: SourceInfo) {
  const system = `You are a US promotional products market analyst. You recognize product categories and recommend search keywords/ASINs to find similar items on Amazon and ASI distributor catalogs (espn / PPAI / SAGE).
You will look at product photos (front view, multi-angle if available) plus the 1688 source data, and output STRICT JSON only (no markdown, no commentary).`

  const imageList = (source.images ?? [])
    .slice(0, 6)
    .map((u, i) => `${i + 1}. ${u.length > 200 ? '[base64 ' + u.length + ' chars]' : u}`)
    .join('\n')

  const user = `Find US promotional product equivalents for this 1688 item.

1688 SOURCE
- Title: ${source.sourceTitle || '(not provided)'}
- Description: ${source.description || '(not provided)'}
- Material: ${source.materialCn || '(unknown)'}
- Colors: ${source.colorsCn || '(unknown)'}
- Size: ${source.sizeCn || '(unknown)'}
- Category hint: ${source.category || '(unknown)'}

PRODUCT IMAGES (you will analyze them visually):
${imageList}

OUTPUT JSON SCHEMA:
{
  "productType": "<2-5 word English product type, e.g. '20oz Stainless Tumbler'>",
  "visualFeatures": ["<4-8 visible features: shape, color, finish, opening style, lid type, accessories>"],
  "categoryGuess": "<one best-fit ASI category>",
  "amazonSearchTerms": ["5-10 English search queries that would surface this on Amazon US, ordered most→least specific"],
  "amazonSearchUrl": "single https://www.amazon.com/s?k=<url-encoded best query>",
  "asiSearchTerms": ["5-8 English search queries for ASI/PPAI/SAGE distributor sites"],
  "asiSearchUrl": "single https://www.google.com/search?q=<url-encoded ASI query> (Google is the easiest way to surface ASI distributor catalogs)",
  "amazonItems": [
    { "title": "<Amazon product title>", "asin": "<B0xxxxxxxx or empty>", "priceUsd": <number or null>, "url": "https://www.amazon.com/dp/<asin>", "note": "<1-line why this is a competitor>" }
  ],
  "asiItems": [
    { "title": "<distributor catalog product title>", "brand": "<brand line name>", "url": "https://...", "note": "<1-line why this is a competitor>" }
  ],
  "likelyAsins": ["0-5 plausible ASINs you might have seen for similar items (B0xxxxxxxx format, leave empty array if unsure)"],
  "competingBrands": ["3-6 US promo catalog brand line names that compete in this category, e.g. 'Yeti', 'Brumate', 'Corkcicle' (do NOT invent; only list commonly known ones)"],
  "referenceTitles": ["3-5 example US-distributor-style titles for the same product"],
  "suggestions": [
    "3-5 concrete Chinese suggestions for the salesperson (e.g. '优先用 asinseed.com 查上述 ASIN 的高频词，补充到标题前 30 字符', '对比 CamelBak / Hydro Flask 价位，把 250pc 定价定在 $4-$6 区间', '主图换白色背景 + 尺寸参照物（USD 1 角硬币）提升点击率')"
  ],
  "priceRangeUsd": { "min": <typical 250pc price in USD>, "max": <typical 250pc price in USD> }
}

Rules:
- Do NOT invent ASINs if you don't recognize the product. Return empty array.
- Do NOT include actual trademarks as competing brands you sell under (you can list them as competing brands for analysis). Never write a title that contains a real trademark unless the user is making a licensed product.
- Amazon search queries should be 2-5 words, benefit-aware, that a corporate buyer would type.
- ASI search queries should include category terms distributors use (e.g. '20oz tumbler', 'vacuum insulated drinkware').
- amazonItems / asiItems: list the 3-6 most representative competitors with a 1-line note. URLs can be generic Amazon/Google search URLs when you don't have the exact ASIN.`

  return { system, user }
}

/**
 * AI 助手对话窗口：用户只提供 1688 基础信息（材质/尺寸/箱规/卖点），
 * AI 自行研究补全（不反问"这个产品用于什么场景"之类的无意义问题）。
 * 返回自然语言回复 + 可选的结构化补丁（直接更新 listing 字段）。
 */
export function buildAssistantPrompt(
  source: SourceInfo,
  listing: Partial<Listing> | null,
  messages: ChatMessage[],
  /** 分区对话模式：只允许讨论/修改这些 listing 字段（区块级 AI 对话窗口） */
  scopeFields?: string[]
) {
  const scopeNote = scopeFields?.length
    ? `

SCOPED SECTION MODE: The salesperson opened the AI chat for ONE section of the listing.
- Only these listing fields may be discussed or modified: ${scopeFields.join(', ')}.
- The "patch" you return MUST only contain keys from: ${scopeFields.join(', ')}.
- If asked to change anything outside these fields, politely reply (in Chinese) that this window only edits the current section.`
    : ''
  const system = `${ASI_CONTEXT}${scopeNote}

You are the in-app AI assistant for a Chinese salesperson uploading products to US ASI distributor sites.
The salesperson gives you basic 1688 info (material, size, carton spec, features). You do the research YOURSELF:
- Never ask unnecessary questions like "what scenario is this product used for?" — infer it from the product itself.
- Only ask when a truly blocking fact is missing (e.g. actual unit price).
- When asked to modify the listing, output a JSON patch with the exact fields to change.

Respond with STRICT JSON only (no markdown, no commentary):
{
  "reply": "<Chinese natural-language answer to the salesperson, concise, actionable>",
  "patch": <optional JSON object with Listing fields to update, e.g. {"title": "...", "keywords": [...], "themes": [...], "imprintMethods": [...], "summary": "...", "description": "..."} — omit or use null if no change requested>,
  "notes": ["<optional Chinese warnings, e.g. character limits, compliance>"]
}`

  const conv = messages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'Salesperson' : 'You'}:\n${m.content}`)
    .join('\n\n')

  const user = `1688 PRODUCT
- Title: ${source.sourceTitle || '(empty)'}
- Description: ${source.description || '(empty)'}
- Material (Chinese): ${source.materialCn || '(empty)'}
- Colors (Chinese): ${source.colorsCn || '(empty)'}
- Size: ${source.sizeCn || '(empty)'}
- Carton: ${source.cartonLCm ?? '?'}x${source.cartonWCm ?? '?'}x${source.cartonHCm ?? '?'} cm, ${source.pcsPerCarton ?? '?'} pcs/ctn, ${source.cartonGwKg ?? '?'} kg
- Unit weight: ${source.weightG ?? '?'} g
- Unit price: ¥${source.priceCny ?? '?'}
- MOQ: ${source.moq ?? '?'}
- 1688 URL: ${source.sourceUrl || '(empty)'}

CURRENT LISTING (may be partial)
${JSON.stringify(listing ?? {}, null, 2)}

CONVERSATION
${conv || '(no messages yet — greet briefly and summarize what you can already do)'}

Rules:
- reply in Chinese, keep it under 200 characters unless explaining something complex.
- patch: only include fields you are confident about; respect all ASI field rules (title ≤60, Keyword+Traffic Word+Selling Point+Core Noun, do NOT deliberately emphasize "Custom"; summary ≤130 ending with "Rush service is available"; description ≤800, Amazon-US-similar style, no size, no brand-story structure; keywords ≤30 groups each ≤30 chars ≤4 words Title Case, asinseed-style distributor search terms; themes exactly 5 incl. Anniversary + Sustainable).
- Never output Chinese in patch fields (they go to the US catalog).`

  return { system, user }
}

/**
 * 分块重新生成：只重生成 listing 中指定的若干字段（一个区块，如标题/摘要/描述/关键词/类目/材质/印刷方式），
 * 其余字段保持不变。可附带业务员的一句话要求。返回 STRICT JSON，键与请求的 fields 完全一致。
 */
export function buildFieldsRegeneratePrompt(
  source: SourceInfo,
  listing: Partial<Listing> | null,
  fields: string[],
  instruction?: string
) {
  const system = `${ASI_CONTEXT}

You regenerate ONLY the requested fields of an existing ASI listing. All other fields stay unchanged.
Respond with STRICT JSON only (no markdown, no commentary).
The JSON object MUST contain EXACTLY these keys (same names, flat — do NOT wrap in "value"): ${fields.join(', ')}

Value type by key:
- Array fields (keywords / themes / categories / materials / imprintMethods / warnings / colorChips): JSON array of strings
- All other fields: a single string`

  const user = `1688 PRODUCT
- Title: ${source.sourceTitle || '(empty)'}
- Description: ${source.description || '(empty)'}
- Material (Chinese): ${source.materialCn || '(empty)'}
- Colors (Chinese): ${source.colorsCn || '(empty)'}
- Size: ${source.sizeCn || '(empty)'}
- Carton: ${source.cartonLCm ?? '?'}x${source.cartonWCm ?? '?'}x${source.cartonHCm ?? '?'} cm, ${source.pcsPerCarton ?? '?'} pcs/ctn, ${source.cartonGwKg ?? '?'} kg
- Unit weight: ${source.weightG ?? '?'} g
- Unit price: ¥${source.priceCny ?? '?'}
- MOQ: ${source.moq ?? '?'}
- 1688 URL: ${source.sourceUrl || '(empty)'}

CURRENT LISTING (context only — keep the same product facts and style; do NOT change other fields)
${JSON.stringify(listing ?? {}, null, 2)}

REGENERATE ONLY THESE KEYS: ${fields.join(', ')}
${instruction ? `Salesperson instruction (MUST be respected): ${instruction}` : '(no special instruction — improve quality while keeping the same product facts)'}

Rules:
- Output ONLY the requested keys. Never output other fields.
- Respect all ASI rules per field: title ≤60 chars, Keyword+Traffic Word+Selling Point+Core Noun, do NOT deliberately emphasize "Custom"; summary ≤130 chars ending with EXACTLY "Rush service is available"; description ≤800 chars, Amazon-US-similar style, no size mention, no brand-story structure; keywords ≤30 groups each ≤30 chars ≤4 words Title Case, built from asinseed-style ASIN high-frequency terms + the seed library, written as US distributor search queries; themes EXACTLY 5 incl. "Anniversary" + "Sustainable"; categories max 2 from the GLS category table (exact strings only); materials from the ASI material list; imprintMethods MUST include "Silkscreen", "Unimprinted", "Full Color" plus relevant extras; colors joined by "/".
- For title, summary and description: NEVER mention colors or color names (color info lives ONLY in the colors/colorChips fields), do NOT specifically state that the logo can be customized / custom logo printing is available (imprinting is the default assumption; the imprintMethods field already covers it), and do NOT describe imprint/printing methods or techniques (that info lives ONLY in the imprintMethods/imprintArea fields).
- English fields (title/summary/description/keywords/categories/themes/materials/imprintMethods/colors) must be English only. Chinese only in *Zh fields.`

  return { system, user }
}

/**
 * 1688 选品自动搜寻：根据目标类目/关键词/预算，AI 推荐适合上传 ASI 的产品方向
 * 与 1688 搜索词（中文），并给出选品理由与定价预期。
 */
export function buildSourcingPrompt(input: {
  category?: string
  keywords?: string
  budgetCny?: number | null
  targetPriceUsd?: { min: number; max: number } | null
  notes?: string
}) {
  const system = `You are a product-sourcing strategist for the US promotional products (ASI) market.
You know what sells: high-perceived-value, low unit cost, easy to ship (small cube), customizable logo surfaces, broad buyer appeal (corporate gifting, trade shows, events).
Respond with STRICT JSON only (no markdown, no commentary):
{
  "directions": [
    {
      "product": "<Chinese product name, e.g. 折叠收纳包>",
      "why": "<Chinese: why this fits ASI market (buyer demand, margin, logistics)>",
      "search1688": ["<2-4 Chinese 1688 search queries>"],
      "category": "<one ASI category from the list>",
      "expectedUnitCostCny": <number>,
      "expectedSellUsd": { "min": <number>, "max": <number> },
      "risks": ["<Chinese, 1-3 items>"]
    }
  ],
  "keywords1688": ["<extra Chinese 1688 search keywords to explore>"],
  "tips": ["<Chinese sourcing tips, 2-4 items>"]
}
Give 3-5 directions, ordered by overall opportunity.`

  const user = `Suggest products to source on 1688 for the US ASI promotional market.

CONSTRAINTS
- Target ASI category: ${input.category || '(open — recommend best categories)'}
- Keywords/interests: ${input.keywords || '(none)'}
- Max unit budget: ${input.budgetCny ? `¥${input.budgetCny}` : '(flexible, prefer ≤ ¥30)'}
- Target retail (250pc tier): ${input.targetPriceUsd ? `$${input.targetPriceUsd.min}-$${input.targetPriceUsd.max}` : '$1-$10 typical promo range'}
- Notes: ${input.notes || '(none)'}

Rules:
- Prefer products: small & light (air-freight friendly), large flat imprint area, no battery/certification hassles, MOQ ≤ 500.
- search1688 queries must be practical Chinese terms a 1688 supplier would list under.
- expectedSellUsd must be consistent with expectedUnitCostCny (typical 2.5-4x markup at 250pc).`

  return { system, user }
}