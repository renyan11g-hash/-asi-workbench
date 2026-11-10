/**
 * Listing 质量检查（批量生产系统 V1 · 第二阶段第 4 点）。
 *
 * 分两层：
 *  ① 程序规则 —— 长度、结尾句、关键词数量/重复/单组长度、无资料支持的参数与认证。
 *     全部本地计算，不花 token、不排队，批量生成完立刻能给结果。
 *  ② AI 复检 —— 语法错误 / 不自然的美国英语 / 语气问题。这类只能靠模型判断，
 *     所以做成单独的「AI 复检」动作（单条或整批），不默认每条都调，避免批量时代价翻倍。
 *
 * 判定口径：
 *  - level='error'  平台会直接拒收（超长、缺结尾句、关键词超量）
 *  - level='warn'   不拦，但需要人看一眼（关键词不足/重复、疑似无资料支持的参数）
 *  - 只有 error 全过才算 ok=true。
 */

import { ASI_MATERIALS, LIMITS, MATERIAL_DICT } from '../constants/asi'
import type { Listing, ProductSpecs, SourceInfo } from '../types'
import { SPEC_FIELDS, UNKNOWN } from './spec-fields'
import { forbiddenHits } from './listing-copy'

export type QcLevel = 'error' | 'warn'

export interface QcCheck {
  key: string
  label: string
  ok: boolean
  level: QcLevel
  /** 给人看的具体说明（不通过时一定非空） */
  detail: string
}

export interface ListingQcReport {
  ok: boolean
  checks: QcCheck[]
  /** 疑似没有资料支持的说法（材质/参数/认证/功能） */
  unsupported: string[]
  /** 语法与自然度还没检查（需要点「AI 复检」） */
  needsAi: boolean
  aiChecked: boolean
  aiFindings: string[]
  checkedAt: string
}

const RUSH = 'rush service is available'

function str(v: unknown): string {
  return String(v ?? '').trim()
}

/** 把产品所有「有依据」的文字揉成一坨，用来判断某个说法有没有出处 */
function factCorpus(source: SourceInfo | null | undefined, specs: ProductSpecs | null | undefined): string {
  const parts: string[] = []
  if (source) {
    parts.push(
      source.sourceTitle,
      source.description,
      source.materialCn,
      source.colorsCn,
      source.sizeCn,
      source.notes,
      source.category,
      (source.sourceKeywords ?? []).join(' '),
      source.weightG === null || source.weightG === undefined ? '' : `${source.weightG}g`
    )
    if (source.cartonLCm && source.cartonWCm && source.cartonHCm) {
      parts.push(`${source.cartonLCm} ${source.cartonWCm} ${source.cartonHCm} cm`)
    }
    if (source.pcsPerCarton) parts.push(`${source.pcsPerCarton} pcs per carton`)
    if (source.cartonGwKg) parts.push(`${source.cartonGwKg} kg`)
  }
  if (specs) {
    for (const f of SPEC_FIELDS) parts.push(str(specs[f.key]))
  }
  return parts.filter(Boolean).join(' \n ').toLowerCase()
}

/** 英文材质名 → 它在 1688 资料里可能出现的中英文写法 */
function materialAliases(en: string): string[] {
  const aliases = [en.toLowerCase()]
  for (const [re, name] of MATERIAL_DICT) {
    if (name !== en) continue
    // 正则源里去掉锚点/转义，取中文与英文关键词作为「可能出现在原始资料里的写法」
    const src = re.source.replace(/\\b/g, '').replace(/\\/g, '')
    for (const token of src.split('|')) {
      const t = token.trim().toLowerCase()
      if (t.length >= 2 && !/^[.*+?^${}()[\]]+$/.test(t)) aliases.push(t)
    }
  }
  return Array.from(new Set(aliases))
}

/** 常见认证/合规声明：listing 里出现但资料里没有 → 标为无依据 */
const CERT_WORDS = [
  'FDA',
  'LFGB',
  'CPSIA',
  'Prop 65',
  'Proposition 65',
  'BPA Free',
  'BPA-Free',
  'BPA-free',
  'RoHS',
  'REACH',
  'ISO 9001',
  'GRS',
  'CE certified',
  'CE Certified',
  'UL listed',
  'FSC certified',
]

/**
 * 带单位的数值：出现但资料里找不到同一个数 → 标为无依据。
 * 故意只收「不会误伤正常英文」的单位：inch/oz/lb/cm/mm/ml/kg 这类；
 * 不收 in / l / g 这种单个字母（"3 in 1"、"500 g" 之外的场景太容易误判）。
 */
const MEASURE_RE =
  /\b(\d+(?:\.\d+)?)\s*(oz|ounce|ounces|fl oz|lb|lbs|pound|pounds|inch|inches|cm|mm|ml|liter|liters|kg|pcs|pieces)\b/gi

/**
 * 卖家服务/物流话术（不是产品卖点）：1688 页面爱写，AI 有时会顺手带进英文文案。
 * 只做提示，不自动删句子——删错会把正常描述一起删掉。
 */
const SERVICE_TALK: Array<{ label: string; re: RegExp }> = [
  { label: 'fast/quick shipping', re: /\b(fast|quick|rapid|prompt)\s+(shipping|delivery|dispatch)\b/ },
  { label: 'free/cheap shipping', re: /\b(free|cheap|low[- ]cost)\s+shipping\b/ },
  { label: 'ocean/air freight', re: /\b(ocean|air|sea)\s+freight\b/ },
  { label: 'free/fast samples', re: /\b(free|fast|quick|easy)\s+sampl/ },
  { label: 'sample available', re: /\bsampl(e|es|ing)\s+(is\s+)?(available|welcome|supported)\b/ },
  { label: 'low MOQ', re: /\b(low|small|minimum)\s+moq\b/ },
  { label: 'factory direct', re: /\bfactory[- ]direct\b/ },
  { label: 'OEM/ODM service', re: /\b(oem|odm)\b/ },
  { label: 'price negotiable', re: /\bprice\s+(is\s+)?negotiable\b/ },
  { label: 'dropshipping', re: /\bdropship/ },
  { label: '24h dispatch', re: /\b24[- ]?h(our)?s?\s+(dispatch|delivery|shipping)\b/ },
  { label: 'welcome to inquire', re: /\b(welcome|feel free)\s+to\s+(inquir|contact)/ },
]

export interface QcInput {  listing: Partial<Listing> | null | undefined
  source?: SourceInfo | null
  specs?: ProductSpecs | null
}

/** 跑一遍程序规则（不联网、不写库） */
export function runListingQc(input: QcInput): ListingQcReport {
  const listing = input.listing ?? {}
  const title = str(listing.title)
  const summary = str(listing.summary)
  const description = str(listing.description)
  const keywords = Array.isArray(listing.keywords) ? listing.keywords.map((k) => str(k)).filter(Boolean) : []
  const checks: QcCheck[] = []

  checks.push({
    key: 'titleLen',
    label: `Title ≤ ${LIMITS.title} 字符`,
    ok: title.length <= LIMITS.title,
    level: 'error',
    detail:
      title.length <= LIMITS.title
        ? `${title.length} 字符`
        : `${title.length} 字符，超出 ${title.length - LIMITS.title} 个`,
  })

  checks.push({
    key: 'summaryLen',
    label: `Summary ≤ ${LIMITS.summary} 字符`,
    ok: summary.length <= LIMITS.summary,
    level: 'error',
    detail:
      summary.length <= LIMITS.summary
        ? `${summary.length} 字符`
        : `${summary.length} 字符，超出 ${summary.length - LIMITS.summary} 个`,
  })

  const endsRush = summary.toLowerCase().replace(/[.\s]+$/, '').endsWith(RUSH)
  checks.push({
    key: 'summaryRush',
    label: 'Summary 以 "Rush service is available" 结尾',
    ok: endsRush,
    level: 'error',
    detail: endsRush ? '结尾正确' : `结尾是「${summary.slice(-40) || '(空)'}」`,
  })

  checks.push({
    key: 'descriptionLen',
    label: `Description ≤ ${LIMITS.description} 字符`,
    ok: description.length <= LIMITS.description,
    level: 'error',
    detail:
      description.length <= LIMITS.description
        ? `${description.length} 字符`
        : `${description.length} 字符，超出 ${description.length - LIMITS.description} 个`,
  })

  // 卖家服务/物流话术：1688 页面最爱写「发货快、打样方便、厂家直销、OEM 欢迎」，
  // 这些不是产品卖点，ASI 目录里出现只会显得外行。命中就提示改写。
  const copyHay = `${title} ${summary} ${description}`.toLowerCase()
  const serviceHits = SERVICE_TALK.filter((s) => s.re.test(copyHay)).map((s) => s.label)
  checks.push({
    key: 'noServiceTalk',
    label: '只描述产品本身（不含发货/打样/起订量/Dropship 等卖家话术）',
    ok: serviceHits.length === 0,
    level: 'warn',
    detail: serviceHits.length === 0 ? '未出现卖家服务话术' : `命中：${serviceHits.join('、')}，建议改写成产品卖点`,
  })

  // 详细描述只讲产品本身：不允许换行、不允许运输/派发/打样/起订量/克重/箱规
  checks.push({
    key: 'descriptionSingleParagraph',
    label: 'Description 单段落（不允许换行）',
    ok: !/[\r\n]/.test(description),
    level: 'warn',
    detail: /[\r\n]/.test(description) ? `发现 ${(description.match(/[\r\n]/g) ?? []).length} 个换行` : '单段落',
  })

  const descHits = Array.from(new Set(forbiddenHits(description)))
  checks.push({
    key: 'descriptionProductOnly',
    label: 'Description 只描述产品（无运输/派发/打样/起订量/克重/箱规）',
    ok: descHits.length === 0,
    level: 'warn',
    detail: descHits.length ? `命中：${descHits.join('、')}` : '只描述产品本身',
  })

  const overCount = keywords.length > LIMITS.keywordMax
  checks.push({
    key: 'keywordCount',
    label: `Keywords = ${LIMITS.keywordMax} 组`,
    ok: keywords.length === LIMITS.keywordMax,
    // 超出是平台硬限制；不足只是少流量，不拦
    level: overCount ? 'error' : 'warn',
    detail:
      keywords.length === LIMITS.keywordMax
        ? `${keywords.length} 组`
        : overCount
          ? `${keywords.length} 组，超出 ${keywords.length - LIMITS.keywordMax} 组`
          : `${keywords.length} 组，比要求的 ${LIMITS.keywordMax} 组少 ${LIMITS.keywordMax - keywords.length} 组`,
  })

  // 完全重复的关键词组
  const seen = new Map<string, number>()
  const dupes: string[] = []
  for (const k of keywords) {
    const key = k.toLowerCase()
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  for (const [k, n] of seen) if (n > 1) dupes.push(`${k} ×${n}`)
  checks.push({
    key: 'keywordDuplicate',
    label: 'Keywords 无重复',
    ok: dupes.length === 0,
    level: dupes.length ? 'warn' : 'warn',
    detail: dupes.length ? `重复：${dupes.slice(0, 5).join('、')}` : '无完全重复',
  })

  // 单词级重复（ASI 要求每组词尽量不共用单词，共用了会浪费流量位）
  const wordOwner = new Map<string, number[]>()
  keywords.forEach((k, i) => {
    const words = k.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2)
    for (const w of new Set(words)) {
      const list = wordOwner.get(w) ?? []
      list.push(i)
      wordOwner.set(w, list)
    }
  })
  const sharedWords = Array.from(wordOwner.entries())
    .filter(([, list]) => list.length > 1)
    .map(([w, list]) => `${w}(${list.length}组)`)
  checks.push({
    key: 'keywordWordRepeat',
    label: '关键词组之间尽量不共用单词',
    ok: sharedWords.length === 0,
    level: 'warn',
    detail: sharedWords.length ? `${sharedWords.length} 个单词在多组里重复：${sharedWords.slice(0, 6).join('、')}` : '无共用单词',
  })

  // 单组关键词长度/词数
  const badGroups = keywords.filter((k) => k.length > LIMITS.keywordGroup || k.split(/\s+/).length > LIMITS.keywordWords)
  checks.push({
    key: 'keywordShape',
    label: `每组 ≤${LIMITS.keywordGroup} 字符、≤${LIMITS.keywordWords} 个单词`,
    ok: badGroups.length === 0,
    level: 'warn',
    detail: badGroups.length ? `不合规：${badGroups.slice(0, 4).map((g) => `「${g}」`).join('、')}` : '全部合规',
  })

  // ---- 无资料支持的参数 / 材质 / 认证 ----
  const corpus = factCorpus(input.source, input.specs)
  const haystack = `${title} ${summary} ${description} ${keywords.join(' ')}`.toLowerCase()
  const unsupported: string[] = []

  // ① 英文材质：listing 声明了某材质，但产品资料里找不到对应中英文写法
  const declared = new Set<string>()
  const materialsField = Array.isArray(listing.materials) ? listing.materials : []
  for (const m of materialsField) if (str(m)) declared.add(str(m))
  for (const m of str(listing.material).split(/[,，/]/)) if (m.trim()) declared.add(m.trim())
  for (const m of declared) {
    if (!(ASI_MATERIALS as readonly string[]).includes(m)) continue
    // 材质来自 listing.material 字段（AI 按规则产出）不算「正文编造」，只查正文
    const mentionedInCopy = haystack.includes(m.toLowerCase())
    if (!mentionedInCopy) continue
    const aliases = materialAliases(m)
    if (!aliases.some((a) => corpus.includes(a))) unsupported.push(`材质：${m}`)
  }

  // ② 认证声明
  for (const cert of CERT_WORDS) {
    const re = new RegExp(`\\b${cert.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (!re.test(haystack)) continue
    if (!corpus.includes(cert.toLowerCase())) unsupported.push(`认证/合规：${cert}`)
  }

  // ③ 带单位的数值：同一个数字在资料里找不到，就是编的
  const seenMeasures = new Set<string>()
  for (const m of haystack.matchAll(MEASURE_RE)) {
    const num = m[1]
    const unit = m[2].toLowerCase()
    const token = `${num}${unit}`
    if (seenMeasures.has(token)) continue
    seenMeasures.add(token)
    if (!corpus.includes(num)) unsupported.push(`参数：${m[0]}`)
  }

  checks.push({
    key: 'unsupportedClaims',
    label: '不出现没有产品资料支持的参数/材质/认证',
    ok: unsupported.length === 0,
    level: 'warn',
    detail: unsupported.length
      ? `疑似无依据：${Array.from(new Set(unsupported)).slice(0, 8).join('、')}`
      : '未发现无依据的说法',
  })

  const ok = checks.every((c) => c.level !== 'error' || c.ok)
  return {
    ok,
    checks,
    unsupported: Array.from(new Set(unsupported)),
    needsAi: true,
    aiChecked: false,
    aiFindings: [],
    checkedAt: new Date().toISOString(),
  }
}


/** 合并程序检查与 AI 复检结果（AI 结果只加一条 check，不覆盖程序结论） */
export function mergeAiQc(report: ListingQcReport, findings: string[]): ListingQcReport {
  const check: QcCheck = {
    key: 'aiLanguage',
    label: '语法 / 美国英语自然度',
    ok: findings.length === 0,
    level: 'warn',
    detail: findings.length ? findings.slice(0, 6).join('；') : '未发现问题',
  }
  const checks = [...report.checks.filter((c) => c.key !== 'aiLanguage'), check]
  return {
    ...report,
    checks,
    ok: checks.every((c) => c.level !== 'error' || c.ok),
    needsAi: false,
    aiChecked: true,
    aiFindings: findings,
  }
}

export { UNKNOWN }
