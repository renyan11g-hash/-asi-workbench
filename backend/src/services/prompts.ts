import { Settings, SourceInfo, Evaluation, Listing, SimilarResearch, ProductSpecs } from '../types'
import { ASI_CATEGORIES, ASI_THEMES, ASI_MATERIALS, ASI_IMPRINT_METHODS, BRAND_BLOCKLIST, LIMITS, SEED_KEYWORDS } from '../constants/asi'
import { GLS_CATEGORIES } from '../constants/gls-categories'
import { costSummaryForPrompt, convertUnits } from './pricing'
import { formatImprintConstraint } from './imprint-recommend'
import { specsToPromptBlock } from './product-specs'
import type { MarketSnapshot } from './market-probe'

/**
 * 市场证据文本（用于类目打分）：ASI/Amazon 上「同款商品」的标题、品牌、视觉品类判断。
 *
 * 为什么单独抽出来：类目选错的根因是 AI 只看到 1688 中文标题，只能"凭感觉"归类。
 * ASI 分销商给同类商品归到哪个类目，才是这个行业公认的答案——把他们的标题喂给打分器，
 * 类目候选就是"照着同行的分类"排出来的。
 *
 * 注意：**不要**把 ESP 类目分布（marketSnapshot.esp.categories）算进这里。
 * ESP 的命中集合是泛匹配（找沙滩拖鞋会连带命中 144 个 BAGS），把 BAGS/BACKPACKS 当信号
 * 会让 "Bags-Shoe" 这类类目压过 "SLIPPERS"——ESP 类目只作为证据展示给 AI，不参与打分。
 */
export function marketCategoryTexts(similar?: SimilarResearch | null): string[] {
  const out: string[] = []
  if (similar) {
    for (const it of similar.asiItems ?? []) out.push(it.title, it.brand ?? '', it.note ?? '')
    for (const it of similar.amazonItems ?? []) out.push(it.title)
    for (const t of similar.referenceTitles ?? []) out.push(t)
    for (const t of similar.amazonSearchTerms ?? []) out.push(t)
    for (const t of similar.asiSearchTerms ?? []) out.push(t)
    if (similar.productType) out.push(similar.productType)
    if (similar.categoryGuess) out.push(similar.categoryGuess)
  }
  return out.map((t) => String(t ?? '').trim()).filter(Boolean)
}

/** ESP 类目分布（ASI 自己的归类口径）——只给 AI 当证据看，不参与打分 */
export function espCategoryNames(evaluation?: Evaluation | null): string[] {
  const esp = evaluation?.marketSnapshot?.esp
  return (esp?.categories ?? []).map((c) => String(c?.name ?? '').trim()).filter(Boolean)
}

/**
 * 类目打分（不注入、只排序）：产品文本 + 市场证据文本一起当信号。
 * 给「生成后校验」用：AI 选的类目如果在这份榜单里排名很靠后（跟产品/市场证据不沾边），
 * 就用榜首替换它——这就是「要求和产品高度匹配」的兜底。
 */
export function rankRelevantCategories(
  source: SourceInfo,
  extraTexts: string[] = [],
  limit = 10
): Array<{ cat: string; score: number }> {
  const scored = scoreCategories(source, extraTexts)
  return scored.filter((s) => s.score > 0).slice(0, Math.max(1, limit))
}

/** 内部：给全部 GLS 类目打分（降序） */
function scoreCategories(
  source: SourceInfo,
  extraTexts: string[] = []
): Array<{ cat: string; score: number }> {
  // 产品侧文本：标题 + 描述 + 关键词 + 类目提示 + 中文材质 + 市场证据（ASI/Amazon 同款标题等）
  const haystack = [
    source.sourceTitle,
    source.description,
    source.amazonTitle,
    source.category,
    source.materialCn,
    (source.sourceKeywords ?? []).join(' '),
    ...extraTexts,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  // 提取产品侧有效词（≥2 字符的英文词）
  const signals = new Set<string>()
  // 泛词黑名单：这些词在 ASI/Amazon 标题里满天飞（"Bulk Case Packed" / "Custom Logo Gift Set"），
  // 当类目信号会把 Cases-* / Boxes-* 这类噪音家族顶到正确类目前面。
  // 中文桥接（CN_CATEGORY_SIGNALS）是显式加词，不受这个黑名单影响。
  const stop = new Set([
    'the','and','for','with','your','you','our','from','this','that','are','was','its','his','her','all','any','new','best','top','plus','more',
    'custom','customized','personalized','printed','logo','promotional','promo','item','items','product','products','quality','premium','style','styles','design','designs','color','colors','colour','size','sizes',
    'pack','packed','package','packaging','case','cases','bulk','set','sets','piece','pieces','pcs','wholesale','supplier','factory','oem','odm','free','sample','samples',
    'hot','sale','cheap','gift','gifts','giveaway','brand','branded','available','rush','service','perfect','great','good','made','make','used','use','using',
    'including','include','includes','line','series','model','type','kind','large','small','mini','big','light','heavy','durable','portable','outdoor','indoor',
  ])
  for (const w of haystack.match(/[a-z]{2,}/g) ?? []) if (!stop.has(w)) signals.add(w)

  // 中文品类词 → 英文类目信号词（1688 中文标题/描述的关键 bridge，否则英文类目表完全打不中）
  const CN_CATEGORY_SIGNALS: Array<[RegExp, string[]]> = [
    [/保温|真空|保冷|thermos|tumbler/i, ['insulated', 'vacuum', 'tumbler']],
    // 「保温杯/水杯/随行杯」在 1688 上极常见，但只命中「杯」会落到 Cups-*/马克杯，
    // 实际行业里这类产品是 Bottles-*（水杯/保温瓶），所以单独补 bottle/flask 信号
    [/保温杯|保温壶|真空杯|真空壶|水杯|随行杯|吸管杯|运动水壶/i, ['bottle', 'flask', 'tumbler', 'cup']],
    [/水瓶|水壶|运动壶|瓶子|壶/i, ['bottle', 'flask']],
    [/马克杯|咖啡杯|啤酒杯|扎啤|mug|stein/i, ['mug', 'stein']],
    [/啤酒|beer/i, ['beer', 'pint', 'bar']],
    [/杯/i, ['cup']],
    // 注意：不要用裸「酒」——「啤酒杯」也含「酒」，会把 Glass / Shot Size / BAR 这些变体全点亮
    [/红酒|葡萄酒|香槟|威士忌|白酒|洋酒|酒具/i, ['wine', 'glass', 'bar', 'shot']],
    [/杯垫/i, ['coaster']],
    // 包类要分开：中文「包」太泛，全桥接到 backpack 会让托特包/购物袋被归成 BACKPACKS
    [/背包|双肩|书包/i, ['backpack']],
    [/托特|手提包|帆布包|购物袋|环保袋|购物包/i, ['tote', 'bag']],
    [/袋|包|箱包|拎包|收纳包/i, ['bag', 'pack']],
    [/帽/i, ['cap', 'hat', 'headwear']],
    // 鞋类：1688 的「凉鞋/拖鞋/溯溪鞋」在 ASI 里是 SHOES / SLIPPERS / FLIP FLOPS
    [/拖鞋|凉鞋|溯溪鞋|沙滩鞋|鞋|靴/i, ['shoe', 'slipper', 'sandal', 'footwear']],
    [/笔/i, ['pen', 'pencil', 'writing']],
    [/伞/i, ['umbrella']],
    [/钥匙扣|钥匙链|挂绳|工牌|证件|徽章/i, ['keychain', 'chain', 'lanyard', 'badge', 'holder']],
    [/笔记|记事本|手账|日历|plan/i, ['notebook', 'journal', 'planner', 'calendar']],
    [/手机|电子|充电|数据线|耳机|音箱|u盘|支架/i, ['phone', 'electronic', 'tech', 'charger', 'cable', 'usb']],
    [/玩具|积木|拼图|飞盘/i, ['toy', 'game', 'puzzle']],
    [/厨房|厨具|餐具|刀具|砧板|炊具|筷子/i, ['kitchen', 'cutlery', 'utensil', 'knife', 'dining']],
    [/牙刷|洗护|化妆|美容|护肤|梳|镜/i, ['care', 'cosmetic', 'beauty', 'grooming', 'mirror']],
    [/宠物|猫|狗/i, ['pet', 'dog', 'cat']],
    [/灯|照明/i, ['light', 'lamp']],
    [/工具|扳手|螺丝|卷尺|五金/i, ['tool', 'hardware']],
    [/运动|健身|瑜伽|球/i, ['sport', 'fitness', 'gym', 'yoga', 'ball']],
    [/户外|露营|野餐|烧烤/i, ['outdoor', 'camping', 'picnic', 'bbq']],
    [/收纳|整理|置物/i, ['storage', 'organizer']],
    [/贺卡|卡片|贴纸|贴膜/i, ['card', 'sticker', 'decal']],
    [/表|时钟|闹钟/i, ['watch', 'clock']],
    [/风扇|制冷|冰/i, ['fan', 'cooling', 'ice']],
    [/餐盒|饭盒|保鲜|食品罐/i, ['container', 'lunch', 'food']],
    [/毛巾|浴巾/i, ['towel']],
    [/地毯|垫子|脚垫|桌垫|鼠标垫/i, ['mat', 'pad']],
    [/画|海报|挂旗|旗帜|横幅/i, ['flag', 'banner', 'poster']],
    [/印章|印泥/i, ['stamp']],
  ]
  for (const [re, words] of CN_CATEGORY_SIGNALS) {
    if (re.test(haystack)) for (const w of words) signals.add(w)
  }

  // 中文材质 → 英文材质词：类目常带连字符变体（Mugs & Steins-Metal / Tote Bags-Canvas），
  // 只有材质对得上才能选出正确变体，否则 AI 容易挑到 -Glass / -Paper 这种跟实物不符的变体。
  const CN_MATERIAL_SIGNALS: Array<[RegExp, string[]]> = [
    [/不锈钢|stainless/i, ['stainless', 'steel', 'metal']],
    [/铝|aluminum|aluminium/i, ['aluminum', 'metal']],
    [/玻璃|glass/i, ['glass']],
    [/陶瓷|ceramic|porcelain/i, ['ceramic', 'porcelain', 'stoneware']],
    [/塑料|亚克力|acrylic|pp|abs/i, ['plastic', 'acrylic']],
    [/硅胶|silicone/i, ['silicone', 'rubber']],
    [/帆布|canvas/i, ['canvas']],
    [/尼龙|涤纶|nylon|polyester/i, ['nylon', 'polyester']],
    [/皮革|真皮|leather|pu皮/i, ['leather', 'leatherette']],
    [/竹|bamboo/i, ['bamboo', 'wood']],
    [/木|wood/i, ['wood']],
    [/棉|cotton/i, ['cotton']],
    [/纸|paper/i, ['paper']],
  ]
  for (const [re, words] of CN_MATERIAL_SIGNALS) {
    if (re.test(haystack)) for (const w of words) signals.add(w)
  }

  // 单复数兼容的信号命中判断（类目词 "flasks" 可命中信号 "flask"）
  const hitSignal = (w: string): boolean => {
    if (signals.has(w)) return true
    if (w.length > 3 && w.endsWith('s') && signals.has(w.slice(0, -1))) return true
    return signals.has(`${w}s`)
  }

  // 打分：主词（连字符前缀）命中权重最高，但不能按「每个词都加分」——
  // 否则 "Tote Bags-*" 这种两个词都泛的家族会靠 6 分压过 "BACKPACKS" 这种真正精准的单字类目
  // （中文「包」同时桥接 bag/tote，一个词就能让多词主词拿满）。所以主词按整体给分：
  // 全中 4 分 / 只中一个 2 分；其余词各 +1（最多 +3）。
  return GLS_CATEGORIES.map((cat) => {
    const mainWords: string[] = cat.split('-')[0].toLowerCase().match(/[a-z]{2,}/g) ?? []
    const restWords: string[] = (cat.toLowerCase().match(/[a-z]{2,}/g) ?? []).filter((w) => !mainWords.includes(w))
    const mainHits = mainWords.filter(hitSignal).length
    const restHits = restWords.filter(hitSignal).length
    const mainScore = mainHits === 0 ? 0 : mainHits === mainWords.length ? 4 : 2
    const score = mainScore + Math.min(3, restHits)
    return { cat, score }
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // 同分时家族主类目（无连字符，如 SLIPPERS）优先于子类（如 Bags-Shoe），再按短名、字母序
    const aHead = a.cat.includes("-") ? 1 : 0
    const bHead = b.cat.includes("-") ? 1 : 0
    if (aHead !== bHead) return aHead - bHead
    return a.cat.length - b.cat.length || a.cat.localeCompare(b.cat)
  })
}

/**
 * 类目智能筛选：从 GLS（1620 项）类目表里挑出最匹配的 N 个注入提示词。
 *
 * 打分信号 = 产品自身文本（1688 标题/描述/关键词/材质）+ 市场证据文本
 * （ASI/Amazon 同款商品标题、视觉品类判断、ESP 类目分布）。
 * 后者是关键：ASI 分销商把同类商品归到哪个类目，才是这个行业公认的答案。
 *
 * 规则：
 * 1. 中文品类词经「中文 → 英文类目信号词」映射后参与打分（保温杯 → insulated/bottle/mug…）；
 * 2. 类目主词（连字符前缀，如 "Bottles-Insulated" 的 "Bottles"）命中权重更高（+3）；
 * 3. 命中某类目后，同主词族的全部变体一并注入（AI 看到 "Bottles-*" 全家族才能选准）；
 * 4. 全部零命中时均匀采样覆盖 A-Z，不再注入字母序头部杂项误导 AI。
 */
export function pickRelevantCategories(
  source: SourceInfo,
  max = 80,
  /** 市场证据文本（ASI/Amazon 同款标题、ESP 类目名…），留空则只用产品自身文本 */
  extraTexts: string[] = []
): string[] {
  const scored = scoreCategories(source, extraTexts)
  const hits = scored.filter((s) => s.score > 0)
  if (!hits.length) {
    // 零命中兜底：均匀采样覆盖 A-Z（不注入字母序头部杂项）
    const step = Math.max(1, Math.floor(GLS_CATEGORIES.length / max))
    const picked: string[] = []
    for (let i = 0; i < GLS_CATEGORIES.length && picked.length < max; i += step) picked.push(GLS_CATEGORIES[i])
    return picked
  }

  const pickedSet = new Set(hits.slice(0, max).map((h) => h.cat))
  // 家族补齐：前 10 个命中类目的同主词变体全部注入（如 Bottles-* / Mugs & Steins-* 全家族）
  const families = new Set(hits.slice(0, 10).map((h) => h.cat.split('-')[0]))
  for (const cat of GLS_CATEGORIES) {
    if (families.has(cat.split('-')[0])) pickedSet.add(cat)
  }
  // 输出必须按相关性从高到低（不能按类目表字母序）：AI 更可能挑前面几个，
  // 排在字母序前面的 Awards-Sports / Baseball Caps 会把真正的 Bottles-* 挤到后面。
  const ordered = hits.map((h) => h.cat).filter((c) => pickedSet.has(c))
  const seen = new Set(ordered)
  const rest = GLS_CATEGORIES.filter((c) => pickedSet.has(c) && !seen.has(c))
  return [...ordered, ...rest]
}

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
- Keywords: EXACTLY 30 groups (always fill to 30), each ≤ 30 characters, each ≤ 4 words, Title Case, English comma separated.
  - Build the keyword pool from: (a) high-frequency search terms for the SAME product's ASIN on asinseed.com, (b) the SEED keyword library provided in the prompt, deduplicated.
  - Think like a US distributor searching to source this product — use the words they would type to maximize search hit rate, click rate and conversion.
  - You may include a brand name from the SAME product line (e.g. "Yeti Bags" only when it's truly a parallel/clone product line, not the actual brand).
  - DO NOT include obvious branded terms (Disney, Marvel, NBA, NFL, MLB, Sanrio, Hello Kitty, Nike, Apple, Coca, Pepsi, LEGO, Barbie, Tesla, Gucci, LV, etc.).
  - DO NOT force-fit unrelated brands.
- Category: choose ONE exact string from the GLS category list provided in the prompt (it states what the product physically IS).
- Themes: choose EXACTLY 5 from the ASI themes list below; ALWAYS include "Anniversary" and "Sustainable" as two of the five (they are universal); the other 3 must genuinely match this product's audience/use case.
- Material: choose ONE OR MORE from the ASI material list (max 4), joined by English comma (e.g. "Stainless Steel, Aluminum"). Pick every material actually present in the product.
- Colors: translate each Chinese color into its ASI English equivalent and join with "/" (e.g. "Black/Gray/Brown/Orange/Army Green").
- Imprint Methods: choose from the ASI imprint methods list below. ALWAYS include exactly these three: "Silkscreen", "Unimprinted", and "Full Color". Then add only methods from the MATERIAL CONSTRAINT block supplied below — that block is computed from this product's actual material and is authoritative; never add a method listed there as unusable.
- Imprint Area: estimate the printable area in inches for each printable face (Front/Back/Wrap), e.g. 'Front: 2.5" W x 2" H; Wrap: 8" W x 3" H'. Use the uploaded product images + size data.
- Do NOT invent certifications (FDA, UL, CPSIA, BPA-free, etc.) unless the 1688 source explicitly states them.
- Do NOT mention brand names, licensed characters, or trademarks.
- Do NOT add features, materials, or certifications that are not in the 1688 source.
- Quality bar: keyword-rich but natural, benefit-first, no buzzword soup.

SOURCE-TEXT USAGE (strict — this is where AI copy usually goes wrong):
- The 1688 title / description / keywords are a FACT SOURCE ONLY (what the item is, material, structure, parts, capacity, function, application). NEVER copy them, NEVER translate them sentence by sentence, NEVER "lightly reword" them. The English must be written from scratch the way a native US copywriter writes.
- Ignore ALL seller / service / logistics talk from the 1688 page — it never belongs in a catalog listing: fast or cheap shipping, ocean/air freight convenience, easy or fast sampling, free samples, sample fee refund, low MOQ, factory direct, OEM/ODM welcome, price negotiable, welcome to inquire, large stock, 24-hour dispatch, dropshipping.
- Describe ONLY the product itself: what it is, how it is built, what it does, where it is used. Nothing about how easy it is to buy, ship, pack, hand out, distribute or sample it.
- NEVER put logistics numbers into the copy: no unit weight (grams / kg / lb / oz), no carton dimensions, no pieces per carton, no packaging specs. That data is provided to you for calculation only — it belongs to internal fields, not the listing text.
- The Full Description must be ONE single paragraph: no line breaks, no bullet lists, no blank lines.
- Chinese marketplace boilerplate (厂家直销 / 支持定制 / 量大从优 / 发货快 / 来图打样 / 欢迎询价) is NOT a product feature — never carry it into the English copy.

You will also produce a Chinese translation of title/summary/description/keywords for the salesperson to verify.`

export function buildEvaluatePrompt(source: SourceInfo, settings: Settings, market?: MarketSnapshot | null) {
  const system = `${ASI_CONTEXT}

Evaluate the 1688 item for fit with US promotional products market.
Respond with STRICT JSON only (no markdown, no commentary).`

  const esp = market?.esp
  const formLabel = (f?: string) => (f === 'set' ? '套装 (multi-piece set)' : f === 'single' ? '单件 (single item)' : '形态未判定')
  const espBlock =
    esp && esp.total > 0
      ? `SOURCE A — ASI / ESP SUPPLIER NETWORK (supplier.espwebsite.com — the combined catalogue of ASI's ESP supplier sites, i.e. the WHOLE ASI supplier universe; THIS is the broad view of SUPPLY)
- Search terms used: ${esp.queries.join(' | ')}
- Matching products across the whole ASI ESP network: ${esp.total}+ (platform-reported; treat as "at least this many" — the scoring uses the LARGEST of the per-term counts, i.e. the most crowded reading)
- Per search term on ESP: ${esp.byQuery.map((q) => `"${q.query}" → ${q.total} matches (${q.matched}/${q.sampleSize} same-type in the top results)`).join(' · ') || 'n/a'}
- ASI category breakdown of those matches: ${esp.categories.map((c) => `${c.name} ${c.count}`).join(' · ') || 'n/a'}
- Same-type verification on the sampled results (n=${esp.sampleSize}, relevance tokens: ${esp.matchTokens.join(', ') || 'n/a'}): ${esp.matchedSample} of them are genuinely the same product type
- OUR product form: ${formLabel(esp.productForm)}
- Same-form price band (${esp.sameFormCount ?? 0} listings that are the SAME form as ours — THIS is the only band you may use to judge our price): ${
          esp.priceSameForm
            ? `$${esp.priceSameForm.p25} – $${esp.priceSameForm.p75} (median $${esp.priceSameForm.median}, overall $${esp.priceSameForm.min} – $${esp.priceSameForm.max})`
            : 'not enough same-form samples — therefore NO reliable price comparison exists; do not claim our price is high or low'
        }
- Whole-catalogue price band of all same-type hits (MIXES single items with multi-piece sets — directional only, NEVER quote it as "the market price"): $${esp.price?.p25 ?? '?'} – $${esp.price?.p75 ?? '?'} (median $${esp.price?.median ?? '?'}, overall $${esp.price?.min ?? '?'} – $${esp.price?.max ?? '?'})
- Cheapest same-type competitors on ESP (label = form):
${esp.items
  .slice(0, 6)
  .map(
    (i) =>
      `  · [${i.form === 'set' ? 'SET' : 'SINGLE'}] ${i.title}${i.productNo ? ` [${i.productNo}]` : ''} — $${i.priceMin}${i.url ? ` — ${i.url}` : ''}`
  )
  .join('\n')}
${esp.relevanceNote ? `- Caveat from the probe: ${esp.relevanceNote}\n` : ''}
`
      : esp
        ? `SOURCE A — ASI / ESP SUPPLIER NETWORK: searched "${esp.queries.join(' | ')}" and the whole ASI ESP network returned NO matching products. Treat this as genuinely scarce supply, but double-check in "cons" whether it is scarce because the product is unusual or because the English search term is wrong.\n\n`
        : ''

  /*
   * 需求侧：我们的货卖给分销商，所以"分销商在不在卖"比"供应商在不在做"更接近生意。
   * 必须把每家分开列出来，避免又变成"只看一家"。
   */
  const demand = market?.demand
  const demandBlock = demand
    ? `SOURCE C — DISTRIBUTOR DEMAND (${demand.sources.length} US promotional-distributor catalogues searched; we SELL TO distributors, so their shelves are the demand signal)
${demand.sources
  .map(
    (s) =>
      `- ${s.name}: ${
        s.ok
          ? `${s.total != null ? `${s.total} results, ` : ''}${s.matched} same-type${s.sampleSize ? ` (of ${s.sampleSize} sampled)` : ''}${
              s.price?.p25 != null ? `, bulk list $${s.price.p25}–$${s.price.p75}` : ''
            }${
              s.items.length
                ? `\n${s.items
                    .slice(0, 4)
                    .map(
                      (i) =>
                        `    · [${i.form === 'set' ? 'SET' : 'SINGLE'}] ${i.title} — $${i.priceMin}${i.url ? ` — ${i.url}` : ''}`
                    )
                    .join('\n')}`
                : ''
            }`
          : `not reachable (${s.error ?? 'error'})`
      }`
  )
  .join('\n')}
- Distributors carrying a same-type product: ${demand.carriers}/${demand.checked}
- Demand strength score (0-100, computed): ${demand.demandScore}
- Conclusion drawn from the demand side: ${demand.note}
`
    : ''

  /*
   * 识图比价：唯一可以拿来判断"我们的报价贵不贵"的证据。
   * 标题匹配只能看品类拥挤度——三件套礼盒按标题会匹配到单本笔记本，价格完全不可比。
   */
  const vp = market?.priceCheck
  const priceBlock = vp
    ? `PRICE COMPARISON — VISION-VERIFIED SAME PRODUCTS ONLY
- Candidates checked by image: ${vp.checked}, confirmed as the SAME product: ${vp.sameCount}
- ${vp.note}
${
  vp.price
    ? `- Same-product price band (THIS is the only band you may use for a price verdict): $${vp.price.p25} – $${vp.price.p75} (median $${vp.price.median}, overall $${vp.price.min} – $${vp.price.max})`
    : '- There is NO vision-confirmed same product, therefore NO comparable price exists.'
}
- Verified items:
${vp.items
  .filter((i) => i.same)
  .slice(0, 6)
  .map((i) => `  ✔ ${i.title} (${i.source}) — $${i.priceMin}${i.url ? ` — ${i.url}` : ''}`)
  .join('\n') || '  (none)'}
- Rejected examples (same title family, different product — do NOT use their prices):
${vp.items
  .filter((i) => !i.same)
  .slice(0, 4)
  .map((i) => `  ✘ ${i.title} (${i.source}) — $${i.priceMin}${i.reason ? ` — ${i.reason}` : ''}`)
  .join('\n') || '  (none)'}
`
    : ''

  const marketBlock = market
    ? `OVERSEAS MARKET EVIDENCE — three independent REAL sources (catalogue data, not guesses)
${
  market.memberDiscount
    ? `PRICE BASIS: every price below has ALREADY been multiplied by ${market.memberDiscount} (the ASI/ESP member discount) so it is directly comparable with OUR tier prices. Never multiply or divide again; when you quote a competitor price in the output, say the band is already on our basis.\n`
    : ''
}
${espBlock}SOURCE B — 4IMPRINT (also just ONE distributor — see SOURCE C for the multi-distributor picture)
- Raw hits: ${market.total} (RSS caps around 28 per query, so treat as "at least this many")
- Same-product hits after matching on keywords [${market.matchTokens.join(', ') || 'n/a'}]: ${market.matched}
- Density figure from this source only (normalised to a 28-item sample): ${market.densityCount}
- Real list price band (bulk tier, same-product hits only): $${market.price?.p25 ?? '?'} – $${market.price?.p75 ?? '?'} (median $${market.price?.median ?? '?'}, overall $${market.price?.min ?? '?'} – $${market.price?.max ?? '?'})
- Closest competitors:
${market.items
  .slice(0, 8)
  .map((i) => `  · ${i.title} — $${i.priceMin} - $${i.priceMax}`)
  .join('\n')}

${demandBlock}${priceBlock}MARKET-DERIVED ROUGH ESTIMATES (already computed from the sources above): differentiation ≈ ${market.diffEstimate} (supply only), competition ≈ ${market.competitionEstimate} (supply crowding + distributor demand)
${market.relevanceNote ? `- Probing caveats: ${market.relevanceNote}\n` : ''}
HOW TO USE THIS EVIDENCE:
- "differentiation" MUST be judged on SOURCE A (the whole ASI ESP supplier network), NOT on 4imprint alone. 4imprint is a single distributor: a product with 1 hit there can still have hundreds of ASI suppliers making it. Never call a category "thin / niche" just because 4imprint is thin.
- "competition" MUST combine SOURCE A (how many suppliers make it) with SOURCE C (how many distributors already sell it). Many distributors selling it = a real, contested market; say so plainly instead of promising an easy niche.
- DEMAND IS THE GATEKEEPER: our goods are sold TO distributors. If SOURCE C shows 0 distributors carrying anything similar, say it in "issues" and in "summary" ("分销商目录里没人卖同类，需求未验证") — do not present it as a hidden opportunity. If several distributors carry it, the product is validated but contested.
- Land within ±15 of the market-derived estimates above; if you go outside that window, explain in one short Chinese sentence inside "cons" why this product is materially different from the sample.
- PRICE — read this carefully. Price verdicts may ONLY use the "PRICE COMPARISON — VISION-VERIFIED SAME PRODUCTS" band: a same-TITLE product is not a same PRODUCT (a 3-piece gift set vs a single notebook are not comparable, and title tokens cannot tell them apart). If that block says there is no vision-confirmed same product, write "缺识图可比样本" and give NO price verdict — silence is correct, a fabricated band is not.
- Title-based matching (SOURCE A's same-form band, SOURCE C's same-type counts) is for ONE purpose only: judging how crowded the category is. Never quote those numbers as the market price of this product.
- "priceAdviceUsd" MUST come from the vision-verified band when it exists; otherwise fall back to 4imprint's tiered list prices (real distributor prices for this product type) and say in "cons" that the sample is title-level only. Give a sensible sub-range for THIS product's tier.
- If a sample is obviously off-target (different product type), say so in "cons" and still score on product merits.

`
    : ''

  // 印刷方式同理：把材质驱动规则引擎的结论直接给它，别让模型自己推算材质适配性
  const imprintBlock = `${formatImprintConstraint(source)}
ASI IMPRINT METHODS (exact strings ONLY): ${ASI_IMPRINT_METHODS.join(', ')}`

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

${marketBlock}COST MODEL (already calculated)
${costSummaryForPrompt(source, settings)}

${imprintBlock}

OUTPUT JSON SCHEMA (all fields required):
{
  "score": <integer 0-100>,
  "scoreBreakdown": {
    "differentiation": <0-100>,
    "customization": <0-100>,
    "shipping": <0-100>,
    "competition": <0-100>,
    "compliance": <0-100>
  },
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

Scoring guide — you ONLY score the five dimensions; the system computes the final score as a weighted sum
(differentiation 28% / customization 22% / shipping 18% / competition 17% / compliance 15%) and applies hard caps.
 - differentiation 差异化 0-100: 同款是否烂大街、有没有记忆点/可讲的故事（同款泛滥 → 低于 30）
 - customization 定制可行性 0-100: 工艺是否简单、能否小批量打样、logo 位置是否好上、是否要开模（做不了定制 → 低于 30）
 - shipping 物流体积 0-100: 是否抛货、单件是否偏重、装箱率是否低（越轻越紧凑分越高；泡货/重货 → 低于 25）
 - competition 市场竞争 0-100: ASI 目录里同类是否已饱和、是否只能打价格战
 - compliance 合规与知识产权 0-100: 品牌/专利/认证/儿童安全风险（有硬伤 → 低于 40）
Set "score" to your own rough overall estimate as well, but the system will override it with the weighted result.
Judge the PRODUCT, not the price. Never raise or lower any dimension because of estimated pricing, and never invent a market price — "priceAdviceUsd" is a rough reference only and must not drive scores or verdict.
Be brutally honest. The 'issues' list must be CONCRETE and actionable (e.g. '仅一种主色，缺海军蓝/灰色不易匹配客户 VI'), not generic. The 'suggestions' list must be the matching FIX for each issue, e.g. '与供应商沟通加做海军蓝、灰色，至少 5 种颜色可选'.`

  return { system, user }
}

/**
 * 把「选品评估」的结论 + 改善建议整理成英文提示块，注入 listing 提示词。
 *
 * 为什么要把评估结果喂给 listing：评估时已经算过差异化/竞争/物流/合规，
 * 也给出了目标买家、使用场景、卖点钩子和要规避的弱点。生成英文链接时若完全不理它，
 * 就会出现「评估说卖点要打办公人群，listing 却在写露营」这种自相矛盾。
 *
 * 注意：建议本身是中文，AI 要用英文表达；但只能写「事实上成立」的内容，
 * 不能为了满足建议去编造参数——这与「不许编造」的硬规则冲突时以硬规则为准。
 */
export function formatEvaluationAdvice(evaluation?: Evaluation | null): string {
  if (!evaluation) return ''
  const lines: string[] = []
  if (evaluation.verdict || typeof evaluation.score === 'number') {
    lines.push(
      `- Screening verdict: ${evaluation.verdict ?? 'n/a'} (internal score ${
        evaluation.score ?? 'n/a'
      }/100 — NEVER mention the score, the verdict word, or the fact that an evaluation exists in any output field)`
    )
  }
  if (evaluation.summary) lines.push(`- Why it scored this way: ${evaluation.summary}`)
  if (evaluation.pros?.length) {
    lines.push(
      `- VERIFIED STRENGTHS from the screening step (these are real, product-supported advantages — make them the backbone of the selling points):`
    )
    for (const s of evaluation.pros.slice(0, 8)) lines.push(`  • ${s}`)
  }
  if (evaluation.cons?.length) {
    lines.push(
      `- KNOWN WEAKNESSES (never state them as claims, never "prove them wrong"; simply do not build copy on them):`
    )
    for (const s of evaluation.cons.slice(0, 8)) lines.push(`  • ${s}`)
  }
  if (evaluation.suggestions?.length) {
    lines.push(
      `- ACTIONABLE IMPROVEMENTS from the screening step (Chinese; convert the *intent* into English copy — positioning, selling points, packaging or production wording — but only where it is factually true for this product):`
    )
    for (const s of evaluation.suggestions.slice(0, 8)) lines.push(`  • ${s}`)
  }
  if (evaluation.issues?.length) {
    lines.push(
      `- WEAKNESSES the screening step flagged (do NOT repeat them, do NOT turn them into claims; quietly avoid them):`
    )
    for (const s of evaluation.issues.slice(0, 6)) lines.push(`  • ${s}`)
  }
  if (evaluation.listingHooks?.length) {
    lines.push(`- Selling-point hooks recommended (use as the backbone of title/summary/description):`)
    for (const s of evaluation.listingHooks.slice(0, 8)) lines.push(`  • ${s}`)
  }
  if (evaluation.buyers?.length) {
    lines.push(
      `- Target buyers detected: ${evaluation.buyers.slice(0, 8).join('; ')} → aim the copy and the keyword groups at THESE buyers`
    )
  }
  if (evaluation.occasions?.length) {
    lines.push(`- Use occasions detected: ${evaluation.occasions.slice(0, 8).join('; ')}`)
  }
  if (evaluation.channels?.length) {
    lines.push(`- Sales channels detected: ${evaluation.channels.slice(0, 8).join('; ')}`)
  }
  if (evaluation.suggestedThemes?.length) {
    lines.push(
      `- Themes the screening step leaned toward (still obey the mandatory 'Anniversary' + 'Sustainable'): ${evaluation.suggestedThemes.join(', ')}`
    )
  }
  if (evaluation.suggestedMaterial) {
    lines.push(`- Material the screening step leaned toward: ${evaluation.suggestedMaterial}`)
  }
  if (evaluation.suggestedImprintMethods?.length) {
    lines.push(
      `- Imprint methods the screening step leaned toward (still obey the MATERIAL CONSTRAINT above — it wins on conflicts): ${evaluation.suggestedImprintMethods.join(', ')}`
    )
  }
  if (evaluation.priceAdviceUsd) {
    lines.push(
      `- Price band the screening step considered realistic: $${evaluation.priceAdviceUsd.min}-$${evaluation.priceAdviceUsd.max} (do NOT print prices in the listing; use it only to judge whether the copy should stress value or premium positioning)`
    )
  }
  if (evaluation.risks?.length) {
    lines.push(`- Risks / compliance notes (reflect the real ones in "warnings", in English, max 4):`)
    for (const s of evaluation.risks.slice(0, 5)) lines.push(`  • ${s}`)
  }
  if (!lines.length) return ''
  return `\n\nSCREENING ADVICE (produced by the earlier product evaluation of the SAME product — treat it as internal direction, never mention it in the output):
${lines.join('\n')}

HOW TO USE THE SCREENING ADVICE (mandatory):
1. The advice is written in Chinese. Express it in natural US promo English — never translate it word-for-word and never paste Chinese into English fields.
2. USE THE VERIFIED STRENGTHS: at least TWO of the "VERIFIED STRENGTHS" bullet points must show up as concrete, buyer-facing benefits in the summary or description (not as vague adjectives — say what the buyer gets).
3. APPLY THE IMPROVEMENTS: pick the 1-2 "ACTIONABLE IMPROVEMENTS" that are factually supported by the source data and let them shape the POSITIONING (who it is for, which occasion, what makes it the safe choice). Do not invent facts to satisfy a suggestion.
4. AVOID THE WEAKNESSES: nothing in the copy may state, imply or "answer" a KNOWN WEAKNESS or flagged issue. Do not claim what the product cannot prove.
5. Make it read like a human ASI copywriter wrote it for THIS product — concrete nouns and use cases, no generic filler ("high quality", "great gift", "perfect for everyone"), no sentence that could apply to any product in the category.
6. Facts still come ONLY from the 1688 source and the salesperson's answers. If an improvement suggestion would require a fact we do not have (a certification, a material, a capacity), leave it out instead of inventing it.
7. If the advice conflicts with any rule above (title length, no colors in title, no imprint method in copy, mandatory themes, ASI enums), the rule wins.`
}

/**
 * 类目证据块：ASI 分销商 / Amazon 上同款商品的真实标题 + ESP 类目分布。
 * 生成与「局部重生成类目」两处提示词共用同一份证据，避免两套口径选出不同类目。
 */
export function formatCategoryEvidence(
  similar?: SimilarResearch | null,
  evaluation?: Evaluation | null
): string {
  const parts: string[] = []
  const asiTitles = (similar?.asiItems ?? []).map((i) => i.title).filter(Boolean)
  const amazonTitles = (similar?.amazonItems ?? []).map((i) => i.title).filter(Boolean)
  const espCats = (evaluation?.marketSnapshot?.esp?.categories ?? []).filter((c) => c?.name)
  if (similar?.productType) parts.push(`- Visual product type (from the product photos): ${similar.productType}`)
  if (similar?.categoryGuess) parts.push(`- ASI category guess from the photos: ${similar.categoryGuess}`)
  if (asiTitles.length)
    parts.push(
      `- ASI distributor products that are the same thing:\n${asiTitles
        .slice(0, 6)
        .map((t) => `    · ${t}`)
        .join('\n')}`
    )
  if (amazonTitles.length)
    parts.push(
      `- Amazon same-product titles:\n${amazonTitles
        .slice(0, 5)
        .map((t) => `    · ${t}`)
        .join('\n')}`
    )
  if (espCats.length)
    parts.push(
      `- ASI ESP category breakdown of these matches (broad search — ignore categories that clearly belong to OTHER products in the set, e.g. bags listed when the product is footwear): ${espCats
        .slice(0, 8)
        .map((c) => `${c.name} (${c.count})`)
        .join(' · ')}`
    )
  if (!parts.length) return ''
  return `\n\nCATEGORY EVIDENCE — how ASI distributors classify THIS product (mirror their choice; do NOT guess from the Chinese title):\n${parts.join('\n')}`
}

export function buildListingPrompt(
  source: SourceInfo,
  settings: Settings,
  answers?: ListingAnswer[],
  similar?: SimilarResearch | null,
  evaluation?: Evaluation | null,
  /** 结构化产品资料（14 字段）——有就注入，没有就完全沿用原来的提示词 */
  specs?: ProductSpecs | null
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
  // 类目来自金山文档「Categories」表。候选排序 = 产品自身文本 + 市场证据（ASI/Amazon 同款标题、ESP 类目）。
  // 只给 AI 最相关的 40 个候选（不是 1620 全表），并附上「同行怎么归类的」证据，选错率明显更低。
  const marketTexts = marketCategoryTexts(similar)
  const categoriesPick = pickRelevantCategories(source, 40, marketTexts).join(', ')
  // 类目/主题证据：把 ASI/Amazon 同款商品的真实标题与 ESP 类目分布摆出来，让 AI 照着同行的分类口径选
  const categoryEvidence = formatCategoryEvidence(similar, evaluation)
  const materialsPick = ASI_MATERIALS.join(', ')
  const imprintsPick = ASI_IMPRINT_METHODS.join(', ')
  // 印刷方式材质驱动：先用本地规则引擎按 1688 材质算出「能用/必含/绝不能用」，AI 只在该集合里挑
  const imprintConstraint = formatImprintConstraint(source)

  const answersBlock = answers?.length
    ? `\n\nANSWERS FROM THE SALESPERSON (use as the source of truth for selling points; do NOT add anything not stated here):\n${answers
        .map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer || '(skipped)'}`)
        .join('\n')}`
    : ''

  // 方案 A：注入「看图找类似」的市场调研结果，作为 ASIN 流量词的真实来源
  // 选品评估的结论/建议 → listing 的方向（目标买家、卖点钩子、要规避的弱点）
  const evaluationAdvice = formatEvaluationAdvice(evaluation)

  const similarBlock = ((): string => {
    if (!similar) return ''
    const parts: string[] = []
    if (similar.amazonSearchTerms?.length) parts.push(`- Amazon search terms: ${similar.amazonSearchTerms.join(', ')}`)
    if (similar.asiSearchTerms?.length) parts.push(`- ASI distributor search terms: ${similar.asiSearchTerms.join(', ')}`)
    if (similar.likelyAsins?.length) parts.push(`- Likely ASINs: ${similar.likelyAsins.join(', ')}`)
    if (similar.competingBrands?.length) parts.push(`- Competing brands: ${similar.competingBrands.join(', ')}`)
    const asins = (similar.amazonItems ?? []).filter((it) => it.asin).map((it) => `${it.asin} (${it.title})`)
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
- Buyer notes: ${source.notes || '(none)'}${specsToPromptBlock(specs)}
${answersBlock}${similarBlock}${evaluationAdvice}${categoryEvidence}

HOW TO USE THE 1688 SOURCE (critical — read before writing a single word)
- Use it ONLY to extract facts: what the product physically is, material, structure/parts, capacity, function, application.
- NEVER copy or lightly reword a 1688 sentence into English, and never translate it line by line. Write fresh, native US English from scratch.
- DROP every seller / service / logistics claim from the source (fast shipping, cheap freight, easy sampling, free samples, low MOQ, factory direct, OEM/ODM welcome, price negotiable, big stock, welcome to inquire). None of those may appear in title, summary, description or keywords.
- The Full Description must talk about the PRODUCT ONLY (what it does for the user, how it is built, where it is used) — never about shipping convenience, sampling speed, lead time or ordering process.
- Every claim must still be true to the source facts OR the salesperson's answers; do not invent features, materials or certifications.

REFERENCE ENUMERATIONS (pick from these EXACT strings, do NOT invent new ones)- Categories (1-2, MUST be exact strings from the candidate list below; the list is already ranked by how well each one matches this product AND the ASI/Amazon evidence above): ${categoriesPick}
  HOW TO CHOOSE (this field drives product exposure — a wrong category means the buyer never finds it):
  1. Read the CATEGORY EVIDENCE block above (ASI distributor same-type products, Amazon same-product titles, ESP category breakdown). If ASI distributors file this product under a certain kind of category, choose THAT kind — mirror the industry's classification, do not invent your own idea of what the product is.
  2. The category must state WHAT THE PRODUCT PHYSICALLY IS (an insulated steel bottle → "Bottles-Insulated"; a ceramic coffee mug → "Mugs & Steins-Ceramic"). Never pick a category describing a different product, a use case, an audience, or a component.
  3. The chosen string MUST appear verbatim in the candidate list above. If the best ASI-style category is not in the list, pick the CLOSEST one from the list instead — never output a string that is not in the list, and never output a Chinese category.
  4. Output "category" = the single primary category; "categories" = 1-2 entries whose FIRST item is exactly the same string as "category". Prefer 2 only when the second is a genuine second home for the product (e.g. a drinkware item that is also a travel accessory); otherwise 1 is enough.
- ASI Type of Product (one ASI top-level category, drives section placement): ${ASI_CATEGORIES.join(' | ')}
  This is the coarse bucket (e.g. Drinkware / Bags & Luggage / Writing Instruments). It must agree with the GLS category you chose above.
- ASI Themes (exactly 5, MUST include 'Anniversary' and 'Sustainable'): ${themesPick}
  The other 3 themes must GENUINELY match this product's audience/use case (e.g. camping gear → 'Camping', 'Outdoor'; office giveaway → 'Corporate', 'Trade Show'). Use the CATEGORY EVIDENCE to see which themes the same products are sold under. Do NOT pad with unrelated themes, and never repeat a theme.
- ASI Materials (one or more, max 4): ${materialsPick}
- ASI Imprint Methods (exact strings ONLY, never invent one): ${imprintsPick}
  ${imprintConstraint}
- Color style: translate each Chinese color to its ASI English form, join with "/" (e.g. "Black/Gray/Brown/Orange/Army Green").

KEYWORD SEED LIBRARY (high-frequency US promo terms, drawn from asinseed / Amazon promo research, already deduplicated; pick only ones that are RELEVANT to this product, do NOT stuff):
${SEED_KEYWORDS.join(', ')}

KEYWORD BUILD PROCESS (follow this order):
1. PRIMARY GOAL — WRITE LIKE THE SEARCHER: every keyword group must be phrased exactly the way a US distributor would actually type it when sourcing this product on ASI (or into Google/Amazon search). Maximize search hit rate, click rate and conversion: concrete product noun + the qualifiers a real buyer adds (material, feature, use case, audience), in natural US search phrasing — never marketing fluff, internal jargon or abstract filler. Before finalizing each group, test it: "Would a real distributor type this into the ASI search bar?" If not, rewrite or replace it.
2. Identify the Amazon US same-product / clone product line for this item and its typical search terms — these are the queries distributors already type. If a MARKET RESEARCH block is present below, USE it as the authoritative source for the same-product ASINs, titles and traffic terms (do not invent different ones).
3. Blend the high-frequency terms of that ASIN (asinseed-style research) with the SEED LIBRARY above, deduplicated — keeping only terms that pass rule 1's searcher-first test.
4. If the product belongs to a well-known parallel/clone product line, you may include that line's brand name in a keyword group (e.g. "Yeti Bags"), but NEVER a licensed brand (Disney, Nike, etc.).
5. WORD-LEVEL GLOBAL UNIQUENESS (critical, in service of rule 1): every single English word may appear in AT MOST ONE keyword group across all 30 groups. Once a noun (e.g. the core product noun) is used in one group, no other group may contain that word, not even inside a different phrase. Repeating words across groups wastes slots, because downstream word-level dedupe tools collapse them into one. To fill 30 groups with zero shared words, use synonyms for the core noun (3 different words), plus distinct features, use cases, audiences and occasions, each with entirely fresh vocabulary.
6. COVERAGE MATRIX (critical, in service of rule 1): the 30 groups must collectively cover FOUR dimensions in rough balance — ① product-name variants & alternative names (different words US customers may call the same product), ② functions & performance (e.g. Insulated, Reusable, Waterproof, Leak-proof, Foldable), ③ material & construction (e.g. Nylon, Double-layer, Single-wall, Canvas), ④ real use scenarios (e.g. Office, Picnic, Outdoor, Travel, Gym). Do not over-concentrate on one dimension.

CALCULATED PRICE GRID (authoritative — DO NOT change numbers, USE these only)
${costSummaryForPrompt(source, settings)}

OUTPUT JSON SCHEMA (all fields required, all values MUST be plain strings/objects/arrays, no markdown):
{
  "title": "≤60 characters (HARD limit — count them). English, Title Case. Structure: Keyword + Traffic Word + Selling Point + Core Noun. Model it on how the SAME product is titled on Amazon US (use the REFERENCE TITLES / MARKET RESEARCH block above when present) and adapt to ASI distributor search habits. Do NOT copy or translate the 1688 title. Do NOT deliberately emphasize 'Custom' (customization is the default assumption). NEVER mention colors or color names in the title. Do NOT mention logo customization / custom logo printing in the title. Do NOT mention imprint/printing methods (e.g. silkscreen, embroidery, laser) in the title.",
  "summary": "≤130 characters (HARD limit). English. DERIVE IT FROM the description above — a compressed version of the same selling points, not an independent piece of copy. Highlight the core selling points. MUST end with EXACTLY 'Rush service is available' (keep one space before it). NEVER mention colors or color names. Do NOT mention logo customization / custom logo printing. Do NOT mention imprint/printing methods. No shipping / sampling / lead-time / ordering talk.",
  "description": "≤800 characters (HARD limit). English. Model it on how similar products of the same type are described on Amazon US / other US marketplaces, adapted to ASI promo style. 50-70% product description + the remaining keywords blended naturally into the sentences (never list keywords separately, never stuff). Describe the PRODUCT ONLY: what it is, how it is built, what it does, where it is used. Do NOT copy, translate or lightly reword the 1688 description. Do NOT mention fast/cheap shipping, freight convenience, easy or fast sampling, free samples, lead time, MOQ, factory direct, OEM/ODM service, price negotiation or ordering process. Do NOT list dimensions or size. NEVER mention unit weight / gram weight / g / kg / lb / oz, carton size, pieces per carton, packaging parameters, or how easy the item is to ship, pack, hand out or distribute. Output ONE single paragraph with NO line breaks (never use \n). No brand-story copy structure. NEVER mention colors or color names (color info lives ONLY in the 'colors'/'colorChips' fields). Do NOT specifically state that the logo can be customized / custom logo is available (imprinting is the default assumption; the Imprint Methods field already covers it). Do NOT describe imprint/printing methods or techniques (that info lives ONLY in the 'imprintMethods'/'imprintArea' fields).",
  "keywords": "single string of EXACTLY 30 groups separated by English commas (count them — always 30). PRIMARY GOAL: each group is phrased exactly as a US distributor would type it when sourcing this product on ASI — maximize search hit rate, click rate and conversion. Each group ≤30 chars, ≤4 words. Title Case. Built from asinseed-style ASIN high-frequency terms + the SEED LIBRARY. STRICT word-level dedupe: NO English word may repeat across different groups (each word appears exactly once in the whole string; use synonyms instead). If you run out of ideas, extend with product-attribute variants (material, use case, audience, occasion, style, feature) — never pad with irrelevant words. Do NOT include obvious brand names like ${BRAND_BLOCKLIST.slice(0, 6).join(', ')}.",
  "category": "the PRIMARY category, ONE exact string from the GLS category list above",
  "typeOfProduct": "Type of Product: the ONE best-fit ASI top-level category from this exact list: ${ASI_CATEGORIES.join(' | ')}. Pick the single most representative category for this product.",
  "categories": ["1-2 GLS categories from the list above; the first MUST equal \"category\"; pick the most relevant for this product (max 2)"],
  "themes": ["exactly 5 ASI theme strings, MUST include 'Anniversary' and 'Sustainable'; the other 3 must genuinely match this product's audience/use case"],
  "material": "ONE OR MORE from the above ASI material list, joined by English comma (e.g. 'Stainless Steel, Aluminum'), max 4",
  "materials": ["array form of the same materials"],
  "colors": "color string joined by '/', e.g. 'Black/Gray/Brown/Orange/Army Green'",
  "colorChips": ["individual English color names used in 'colors'"],
  "imprintMethods": ["the three REQUIRED items 'Silkscreen', 'Unimprinted', 'Full Color' PLUS compatible methods from the above ASI imprint list — include every method the product's MATERIAL can support (see MATERIAL CONSTRAINT above), never an incompatible one"],
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

${formatImprintConstraint(source)}
ASI IMPRINT METHODS (exact strings ONLY): ${ASI_IMPRINT_METHODS.join(', ')}
When the conversation touches imprint methods, follow the MATERIAL CONSTRAINT above as FACT — do not invent a method it rules out, and explain the limitation in Chinese if the salesperson asks for one.

CONVERSATION
${conv || '(no messages yet)'}

OUTPUT JSON SCHEMA (must match the original evaluation schema, all fields required):
{
  "score": <integer 0-100, may shift up or down based on conversation>,
  "scoreBreakdown": {
    "differentiation": <0-100>,
    "customization": <0-100>,
    "shipping": <0-100>,
    "competition": <0-100>,
    "compliance": <0-100>
  },
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
- Differentiation MUST be read from marketSnapshot.esp (the whole ASI / ESP supplier network) whenever it exists. marketSnapshot.total / matched describe 4imprint ONLY (a single distributor) — never conclude "niche / thin category / 差异化高" from a low 4imprint count alone.
- Always return all five scoreBreakdown dimensions. The system recomputes the final score from them (weighted + hard caps), so the five numbers are what actually matter.
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
 * 轻量「看图认品类」：只产出三样东西，用来驱动 4imprint 市场探针。
 * 比 buildFindSimilarPrompt 便宜得多（不要求 ASIN / 竞品清单 / 标题模板），
 * 目的是让"中文品名 → 英文搜索词"这一步不再靠单独一次翻译，而是看图直接定名。
 */
export function buildCatalogKeywordsPrompt(source: SourceInfo) {
  const system = `You are a US promotional-products (ASI) sourcing analyst. You look at product photos plus 1688 source data and name the product the way a US distributor would. Output STRICT JSON only, no markdown, no commentary.`

  const imageList = (source.images ?? [])
    .slice(0, 3)
    .map((u, i) => `${i + 1}. ${u.length > 200 ? '[image ' + u.length + ' chars]' : u}`)
    .join('\n')

  const user = `Name this 1688 product for the US promotional-products market (4imprint / ASI distributor catalogue).

1688 SOURCE
- Title: ${source.sourceTitle || '(not provided)'}
- Description: ${(source.description || '(not provided)').slice(0, 600)}
- Material: ${source.materialCn || '(unknown)'}
- Size: ${source.sizeCn || '(unknown)'}
- Amazon-style title: ${source.amazonTitle || '(not provided)'}

PRODUCT IMAGES (analyze them visually):
${imageList || '(no image)'}

OUTPUT JSON SCHEMA:
{
  "productType": "<2-5 word English product type, e.g. 'Hanging Travel Toiletry Bag'>",
  "searchTerms": ["<3-5 English search phrases a US promo-gifts buyer would type on a distributor catalogue, most specific first, 2-4 words each>"],
  "coreKeywords": ["<3-5 SINGLE English nouns that ANY true equivalent product's title must contain, e.g. ['toiletry','bag','hanging']>"]
}

Rules:
- ASCII English letters only. Never output Chinese, never output brand/trademark names.
- coreKeywords decide whether a catalogue hit is really the same product: pick concrete nouns (toiletry, bag, tumbler, umbrella). Do NOT pick vague words like travel, gift, organizer, item, promotional, set.
- searchTerms[0] must be the MOST specific phrase (it drives the catalogue query).
- Be concrete about the actual construction (e.g. "roll up toiletry bag" beats "bag").`

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

${scopeFields?.includes('imprintMethods') ? `${formatImprintConstraint(source)}\nASI IMPRINT METHODS (exact strings ONLY): ${ASI_IMPRINT_METHODS.join(', ')}\n` : ''}CONVERSATION
${conv || '(no messages yet — greet briefly and summarize what you can already do)'}

Rules:
- reply in Chinese, keep it under 200 characters unless explaining something complex.
- patch: only include fields you are confident about; respect all ASI field rules (title ≤60, Keyword+Traffic Word+Selling Point+Core Noun, do NOT deliberately emphasize "Custom"; summary ≤130 ending with "Rush service is available"; description ≤800, Amazon-US-similar style, no size, no brand-story structure; keywords ≤30 groups each ≤30 chars ≤4 words Title Case, asinseed-style distributor search terms collectively covering product-name variants, functions & performance, material & construction, and use scenarios; themes exactly 5 incl. Anniversary + Sustainable).
- Never copy, translate or lightly reword the 1688 text, and never mention shipping convenience / sampling speed / lead time / MOQ / factory direct / OEM service — describe the product itself only.
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
  instruction?: string,
  evaluation?: Evaluation | null,
  /** 市场参考（看图找类似）：重生成类目时用它当证据，跟整篇生成保持同一口径 */
  similar?: SimilarResearch | null
) {
  // 枚举值域注入：分块重生成时 AI 必须从合法字符串中选择（此前只给规则不给列表 → 编造值被后处理丢弃）
  const needsCategories = fields.includes('categories') || fields.includes('category')
  const needsThemes = fields.includes('themes')
  const needsImprints = fields.includes('imprintMethods')
  const categoryEvidence = needsCategories ? formatCategoryEvidence(similar, evaluation) : ''
  const enumBlock = [
    needsCategories
      ? `GLS CATEGORIES (exact strings ONLY — copy verbatim; ranked by how well each matches this product and the ASI/Amazon evidence below; pick the one that states WHAT THE PRODUCT PHYSICALLY IS and mirrors how ASI distributors classify it):\n${pickRelevantCategories(
          source,
          40,
          marketCategoryTexts(similar)
        ).join(', ')}`
      : '',
    needsThemes ? `ASI THEMES (exact strings ONLY):\n${ASI_THEMES.join(', ')}` : '',
    needsImprints
      ? `ASI IMPRINT METHODS (exact strings ONLY): ${ASI_IMPRINT_METHODS.join(', ')}\n${formatImprintConstraint(source)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const system = `${ASI_CONTEXT}

You regenerate ONLY the requested fields of an existing ASI listing. All other fields stay unchanged.
Respond with STRICT JSON only (no markdown, no commentary).
The JSON object MUST contain EXACTLY these keys (same names, flat — do NOT wrap in "value"): ${fields.join(', ')}

Value type by key:
- Array fields (keywords / themes / categories / materials / imprintMethods / warnings / colorChips): JSON array of strings
- All other fields: a single string${enumBlock ? `\n\nALLOWED VALUES (copy EXACT strings — never invent new ones):\n${enumBlock}` : ''}`

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
${instruction ? `Salesperson instruction (MUST be respected): ${instruction}` : '(no special instruction — improve quality while keeping the same product facts)'}${formatEvaluationAdvice(evaluation)}${categoryEvidence}

Rules:
- Output ONLY the requested keys. Never output other fields.
- Respect all ASI rules per field: title ≤60 chars, Keyword+Traffic Word+Selling Point+Core Noun, do NOT deliberately emphasize "Custom"; summary ≤130 chars ending with EXACTLY "Rush service is available"; description ≤800 chars, Amazon-US-similar style, no size mention, no brand-story structure; keywords EXACTLY 30 groups (always fill to 30) each ≤30 chars ≤4 words Title Case, built from asinseed-style ASIN high-frequency terms + the seed library, written as US distributor search queries, and NO English word may repeat across groups (word-level global dedupe; use synonyms); the 30 groups must collectively cover product-name variants, functions & performance, material & construction, and real use scenarios; themes EXACTLY 5 incl. "Anniversary" + "Sustainable" (other 3 must genuinely match this product's audience/use case); categories max 2 from the GLS category list above (copy EXACT strings); materials from the ASI material list; imprintMethods MUST include "Silkscreen", "Unimprinted", "Full Color" plus MATERIAL-COMPATIBLE extras only; colors joined by "/".
- For title, summary and description: NEVER mention colors or color names (color info lives ONLY in the colors/colorChips fields), do NOT specifically state that the logo can be customized / custom logo printing is available (imprinting is the default assumption; the imprintMethods field already covers it), and do NOT describe imprint/printing methods or techniques (that info lives ONLY in the imprintMethods/imprintArea fields).
- The 1688 title/description is a FACT SOURCE ONLY. Do NOT copy, translate or lightly reword it, and never mention shipping convenience, sampling speed, lead time, MOQ, factory direct or OEM/ODM service. Write fresh native US English about the product itself.
- Description ≤800 chars, ONE single paragraph (no line breaks), product-only: no shipping / freight / delivery / dispatch / distribution talk, no unit weight (g / kg / lb / oz), no carton size or pieces-per-carton, no sampling / MOQ / lead time / factory-direct / OEM. Summary ≤130 chars, derived from the description, ending with EXACTLY "Rush service is available".
- typeOfProduct: MUST be exactly ONE string from the ASI top-level category list (Apparel & Outerwear | Automotive Accessories | Awards & Trophies | Baby, Toddler, & Child Items | Bags & Luggage | Caps & Hats | Drinkware | Electronics & Tech Products | Equipment and Business Services | Food, Beverage & Tobacco | Health, Beauty & Wellness | Home & Garden | Jewelry and Accessories | Key Chains | Kitchen & Dining | Lanyard, Badges, & Badge Holders | Magnets & Buttons, Stickers & Decals | Party Supplies | Pet Supplies | Publications | School, Office, & Craft Supplies | Signs, Banners, Flags, & Displays | Sports, Fitness, & Outdoors | Storage & Organization | Tools & Hardware | Toys, Games, & Novelties | Writing Instruments | Other).
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

/**
 * 深度选品研究：输入 4imprint（美国头部 ASI 分销商）热销产品列表，
 * AI 挑选最有机会的对标品、分析卖点、生成 1688 中文搜索词（供后端继续抓取具体 offer）。
 */
export function buildSourcingResearchPrompt(input: {
  category?: string
  keywords?: string
  budgetCny?: number | null
  notes?: string
  asiProducts: Array<{
    name: string
    url: string
    priceFrom: number | null
    priceTo: number | null
    rating: number | null
    category: string
    orderMin: string
  }>
}) {
  const system = `You are a product-sourcing researcher for the US promotional products (ASI) market.
You receive BEST-SELLING products from 4imprint.com (a top US ASI distributor) with price range, rating and minimum order.
Pick the most promising ones, analyze WHY they sell well, and generate practical Chinese 1688 search queries to find similar products on 1688.com.
Respond with STRICT JSON only (no markdown, no commentary):
{
  "directions": [
    {
      "asiProduct": { "name": "<exact name copied from the list>", "url": "<exact url copied from the list>" },
      "why": "<Chinese: why this ASI product sells well (buyer demand, price point, features)>",
      "features": ["<Chinese: 2-4 key selling features of the ASI product>"],
      "search1688": ["<2-3 practical Chinese 1688 search queries for SIMILAR products>"],
      "expectedUnitCostCny": <number>,
      "expectedSellUsd": { "min": <number>, "max": <number> },
      "risks": ["<Chinese, 1-2 items>"]
    }
  ],
  "tips": ["<Chinese sourcing tips, 2-3 items>"]
}
Pick 3-4 ASI products, ordered by overall opportunity. asiProduct.name and asiProduct.url MUST be copied EXACTLY from the provided list.
search1688 queries must be concrete Chinese product terms a 1688 supplier would list under (e.g. 帆布围裙 定制 — never English).`

  const user = `BEST-SELLING 4imprint products${input.category ? ` (category: ${input.category})` : ''}:
${input.asiProducts
  .map(
    (p, i) =>
      `${i + 1}. ${p.name} | $${p.priceFrom ?? '?'}${p.priceTo != null && p.priceTo !== p.priceFrom ? `-$${p.priceTo}` : ''} | rating ${p.rating ?? '-'} | min order ${p.orderMin || '-'} | ${p.url}`
  )
  .join('\n')}

CONSTRAINTS
- Buyer focus category: ${input.category || '(open)'}
- Keywords/interests: ${input.keywords || '(none)'}
- Max unit budget on 1688: ${input.budgetCny ? `¥${input.budgetCny}` : '(flexible, prefer ≤ ¥30)'}
- Notes: ${input.notes || '(none)'}

Rules:
- The 1688 counterpart must be the same product type, logo-customizable, and cheap enough to resell with margin vs the 4imprint price.
- expectedSellUsd should be at or below the 4imprint price range (competitive wholesale for ASI distributors).`

  return { system, user }
}
