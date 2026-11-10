/**
 * 英文文案的「只描述产品」硬过滤。
 *
 * 背景（2026-11-10 用户反馈）：1688 页面大量是卖家话术——发货快、运费便宜、打样方便、
 * 起订量低、箱规紧凑好运输、大货好派发；再加上克重、箱规尺寸这些物流参数。
 * 这些内容出现在 ASI 目录里既不专业也不是产品卖点，但 AI 总会顺手带进 Full Description。
 *
 * 提示词已经加严过几轮仍会漏，所以程序侧兜底：
 *   1) 描述必须先压成「单段落」——用户明确要求不允许换行；
 *   2) 逐句扫描，命中运输 / 打样 / 起订量 / 克重 / 箱规 / 派发 的句子整句剔除；
 *   3) 剔完再按 800 字符硬截断。
 *
 * 注意「不能误伤产品卖点」：
 *   - Lightweight / compact 这类是产品属性，保留；只有出现具体克重数字（60 grams / 17g / 0.2 lb）才删；
 *   - giveaway / handout 作为「用途场景」是 ASI 常用语（trade show giveaway），保留；
 *     只有「好派发」这类便利性描述（easy to hand out / hand out easily）才删。
 */

export interface ForbiddenPattern {
  /** 给用户看的中文原因 */
  label: string
  re: RegExp
}

export const FORBIDDEN_COPY: ForbiddenPattern[] = [
  // ---- 运输 / 物流 ----
  {
    label: '运输/物流',
    re: /\b(ship|ships|shipped|shipping|freight|dispatch|logistics|courier|drop ?ship|sea ?freight|air ?freight)\b/i,
  },
  { label: '运输/物流', re: /\b(fast|quick|rapid|speedy|same[- ]day|next[- ]day)\s+(delivery|shipping|dispatch)\b/i },
  { label: '运输/物流', re: /\b(express|air|ocean|sea)\s+(delivery|freight|shipping)\b/i },
  { label: '运输/物流', re: /\bdelivery\s+(time|cost|window|fee)\b/i },
  // ---- 派发（只说「好派发」这种便利性，不删 giveaway / 用途场景） ----
  {
    label: '派发/分发',
    re: /\b(easy|easily|quick|quickly|simple|simply)\s+to\s+(hand ?out|distribut\w*)\b|\bhand ?out\s+(easily|quickly|without effort)\b|\bbulk\s+distribution\b|\beasy\s+distribution\b/i,
  },
  // ---- 打样 / 起订量 / 工厂服务 ----
  {
    label: '打样/起订量/工厂服务',
    re: /\b(sampl(e|es|ing)|moq|minimum order|oem|odm|factory[- ]direct|lead time|turnaround time|production time|bulk pricing|wholesale pricing|price negotiable|welcome to inquire)\b/i,
  },
  // ---- 克重（只有具体数字才删；lightweight 属于产品属性，保留） ----
  {
    label: '克重/重量',
    re: /\b\d+(?:\.\d+)?\s*(?:g|gram|grams|kg|kgs|kilogram|kilograms|lb|lbs|pound|pounds|oz|ounce|ounces|mg)\b/i,
  },
  {
    label: '克重/重量',
    re: /\b(net|gross|unit|item|product)\s+weight\b|\bweigh(s|ed|ing)?\s+\d/i,
  },
  // ---- 箱规 / 尺寸 / 包装参数 ----
  { label: '箱规/尺寸/包装', re: /\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in\.|ft)\b/i },
  {
    label: '箱规/尺寸/包装',
    re: /\b(carton|cartons|ctn|ctns|pcs per carton|pieces per carton|per carton|packaging|packed in|box size|dimension|dimensions|measurement|measurements|product size|item size|pack density|pack tight|pack down)\b/i,
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

/** 按句号/问号/叹号切句（先压空白，避免换行影响判断） */
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
    if (forbiddenHits(s).length) removed.push(s)
    else kept.push(s)
  }
  // 全被删光：保留原文（QC 会提示人工重生成），不要交一个空描述
  let joined = (kept.length ? kept : sentences).join(' ')
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
