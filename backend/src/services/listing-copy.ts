/**
 * 英文文案的「只描述产品」硬过滤。
 *
 * 背景（2026-11-10 用户第 N 次反馈）：1688 页面大量是卖家话术——发货快、运费便宜、
 * 打样方便、起订量低、厂家直销、大货分装好派发；再加上克重、箱规尺寸这些物流参数。
 * 这些内容在 ASI 目录里既不专业也不是卖点，但 AI 总会顺手带进 Full Description。
 *
 * 光靠提示词写过三次仍然会漏，所以在程序侧兜底：
 *   1) 描述必须先压成「单段落」——用户明确要求不允许换行；
 *   2) 逐句扫描，命中运输 / 打样 / 起订量 / 克重 / 箱规 / 派发 的句子整句剔除；
 *   3) 剔完再按 800 字符硬截断。
 * 剔除结果会写进 QC issues，界面能看到「删掉了哪几句」，方便人工复核。
 */

export interface ForbiddenPattern {
  /** 给用户看的中文原因 */
  label: string
  re: RegExp
}

export const FORBIDDEN_COPY: ForbiddenPattern[] = [
  // ---- 运输 / 物流 ----
  {
    label: '运输方式/物流',
    re: /\b(ship|ships|shipped|shipping|freight|delivery|deliver|dispatch|logistics|courier|transport|air ?freight|ocean|sea ?freight|express|truck|drop ?ship)\b/i,
  },
  {
    label: '到货速度',
    re: /\b(fast|quick|rapid|prompt|speedy|same[- ]day|next[- ]day|24[- ]?hour)\s+(shipping|delivery|dispatch)\b/i,
  },
  // ---- 派发 / 分发（促销行业的"派发方便"不是产品卖点） ----
  {
    label: '派发/分发',
    re: /\b(hand ?out|handing out|distribut(e|ed|ing|ion)|giveaway|give ?away|giveaways|swag bag filler)\b/i,
  },
  // ---- 打样 / 起订量 / 工厂服务 ----
  {
    label: '打样/起订量/工厂服务',
    re: /\b(sampl(e|es|ing)|moq|minimum order|oem|odm|factory[- ]direct|lead time|turnaround|production time|bulk order|wholesale price|price negotiable|welcome to inquire)\b/i,
  },
  // ---- 克重（含 g / kg / lb / oz 等重量单位） ----
  {
    label: '克重/重量',
    re: /\b\d+(?:\.\d+)?\s*(?:g|gram|grams|kg|kgs|kilogram|kilograms|lb|lbs|pound|pounds|oz|ounce|ounces|mg)\b/i,
  },
  {
    label: '克重/重量',
    re: /\b(weight|weights|weighted|net weight|gross weight|lightweight|heavyweight)\b/i,
  },
  // ---- 箱规 / 尺寸 / 包装参数 ----
  {
    label: '箱规/尺寸/包装',
    re: /\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in\.|ft|"|'')\b/i,
  },
  {
    label: '箱规/尺寸/包装',
    re: /\b(carton|cartons|ctn|ctns|pcs per carton|pieces per carton|per carton|packaging|packed in|packing|box size|dimension|dimensions|measurement|measurements|product size|item size)\b/i,
  },
]

/** 判断一句话是否命中「不该出现在产品描述里」的内容 */
export function forbiddenHits(sentence: string): string[] {
  const hits: string[] = []
  for (const p of FORBIDDEN_COPY) {
    if (p.re.test(sentence)) hits.push(p.label)
  }
  return Array.from(new Set(hits))
}

/** 是否是「标题/卖点」句而不是物流句（避免把正常产品句误删时过度过滤） */
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 把一段文案压成「只描述产品」的单段落。
 * @param maxLen 超过就按句子边界截断（描述 800）
 */
export function sanitizeProductCopy(text: string, maxLen: number): { text: string; removed: string[] } {
  const sentences = splitSentences(text ?? '')
  const kept: string[] = []
  const removed: string[] = []
  for (const s of sentences) {
    const hits = forbiddenHits(s)
    if (hits.length) removed.push(s)
    else kept.push(s)
  }
  // 全被删光：宁可保留原文（下一步 QC 会标出来让人工重生成），也不要交一个空描述
  let joined = kept.length ? kept.join(' ') : sentences.join(' ')
  if (!kept.length) joined = sentences.join(' ')
  if (joined.length > maxLen) {
    // 按句子边界截断，尽量不切在单词/句子中间
    const cut = joined.slice(0, maxLen)
    const lastPeriod = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    joined = lastPeriod > maxLen * 0.6 ? cut.slice(0, lastPeriod + 1) : cut.trim()
  }
  return { text: joined.trim(), removed }
}

/** 描述必须是单段落：把换行/制表符压成空格（用户要求不允许换行） */
export function singleParagraph(text: string): string {
  return (text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}
