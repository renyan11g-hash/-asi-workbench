/**
 * Listing 质量检查的 AI 部分（语法 / 美国英语自然度 / 无依据说法）。
 *
 * 单独一个文件的原因：listing-qc.ts 里全是纯规则（可单测、零成本），
 * 只有这里会真的调模型 —— 而且必须由用户显式触发，不能跟着批量生成自动跑，
 * 否则 10 个产品就是 10 次额外模型调用。
 */

import type { Listing, ProductSpecs, Settings, SourceInfo } from '../types'

function str(v: unknown): string {
  return String(v ?? '').trim()
}

import { callChatJsonDetailed } from './ai'
import { SPEC_FIELDS, isKnown } from './spec-fields'
/** 把结构化资料压缩成一段给复检模型看的事实清单 */
function factSheet(specs: ProductSpecs | null | undefined, source: SourceInfo | null | undefined): string {
  const lines: string[] = []
  if (specs) {
    for (const f of SPEC_FIELDS) {
      const v = str(specs[f.key])
      if (isKnown(v)) lines.push(`- ${f.labelEn}: ${v}`)
    }
  }
  if (source) {
    if (source.sourceTitle) lines.push(`- 1688 Title: ${source.sourceTitle}`)
    if (source.materialCn) lines.push(`- 1688 Material: ${source.materialCn}`)
    if (source.sizeCn) lines.push(`- 1688 Size: ${source.sizeCn}`)
    if (source.description) lines.push(`- 1688 Description: ${source.description.slice(0, 1200)}`)
  }
  return lines.length ? lines.join('\n') : `(no fact sheet; treat every specific number/material as unsupported)`
}

/**
 * AI 复检：语法、美国英语自然度、以及「读起来像编的」具体说法。
 * 明确要求它不要重写文案，只挑毛病 —— 避免它把人工改好的内容又改一遍。
 */
export async function runAiListingQc(
  listing: Partial<Listing> | null | undefined,
  source: SourceInfo | null | undefined,
  specs: ProductSpecs | null | undefined,
  settings: Settings,
  productId?: string | null
): Promise<{ ok: boolean; findings: string[]; model: string }> {
  const l = listing ?? {}
  const system = `You are a strict US promotional-products copy reviewer (ASI/PPAI catalog quality).

Review the listing below and report ONLY real problems. You must NOT rewrite it.

Check exactly these:
1. Grammar / spelling / punctuation errors.
2. Unnatural or non-US English phrasing (wrong preposition, Chinese-English calque, awkward compound, wrong article).
3. Claims that are NOT supported by the fact sheet: a number, size, weight, capacity, material, certification, function or feature that the facts do not state.
4. Sales copy that states a fact contradicting the fact sheet.

Rules:
- Be concrete: quote the offending phrase, then say what is wrong in Chinese.
- Do not report style preferences, do not suggest marketing improvements, do not comment on length.
- If the copy is clean, return an empty findings array.
- Output STRICT JSON only, no markdown:
{"findings": ["...", "..."], "ok": true|false}

"ok" is true only when findings is empty.`

  const user = `FACT SHEET (the only allowed source of facts):
${factSheet(specs, source)}

LISTING TO REVIEW:
- Title: ${str(l.title) || '(empty)'}
- Summary: ${str(l.summary) || '(empty)'}
- Description: ${str(l.description) || '(empty)'}
- Keywords: ${(l.keywords ?? []).join(', ') || '(empty)'}
- Materials: ${str(l.material) || '(empty)'}
- Colors: ${str(l.colors) || '(empty)'}
- Packaging: ${str(l.packaging) || '(empty)'}`

  const { data } = await callChatJsonDetailed<{ findings?: unknown; ok?: unknown }>(
    settings,
    system,
    user,
    0.1,
    undefined,
    { task: 'listing-qc', productId }
  )
  const findings = Array.isArray(data.findings)
    ? (data.findings as unknown[]).map((x) => str(x)).filter(Boolean).slice(0, 20)
    : []
  return { ok: findings.length === 0, findings, model: 'qc' }
}
