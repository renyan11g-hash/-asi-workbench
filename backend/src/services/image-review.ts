/**
 * 生成图自动审查（批量生产系统 · 图片环节）。
 *
 * 每次生成完一张图，用视觉模型拿「原产品图」对照「生成图」，按 7 项硬指标体检：
 *   产品一致性 / 颜色一致性 / 结构一致性 / 配件一致性 / 场景合理性 / 背景要求 / 图片质量
 *
 * 不做 Logo 检查：我们的货源基本无 Logo，或者要先去掉原厂 Logo 再上自己的 Logo，
 * 拿「有没有 Logo」当不合格会误伤，所以这一项去掉。
 *
 * 为什么不让程序规则判：这些全是「看图」才能判的（像不像同一件货），
 * 只能用视觉模型；但它只负责挑毛病，不负责改图。
 */

import type { Settings } from '../types'
import { callChatJsonDetailed } from './ai'

export interface ImageReviewCheck {
  key: string
  label: string
  ok: boolean
  note: string
}

export interface ImageReviewResult {
  ok: boolean
  checks: ImageReviewCheck[]
  /** 不通过的项，给人看的短句 */
  issues: string[]
  reviewedAt: string
}

const CHECKS: Array<{ key: string; label: string }> = [
  { key: 'product', label: '产品一致性' },
  { key: 'color', label: '颜色一致性' },
  { key: 'structure', label: '结构一致性' },
  { key: 'accessory', label: '配件一致性' },
  { key: 'scene', label: '场景合理性' },
  { key: 'background', label: '背景要求' },
  { key: 'quality', label: '图片质量' },
]

export interface ReviewInput {
  /** 生成出来的图（data URL 或 http 地址） */
  image: string
  /** 原始产品图（最多 3 张，作为事实基准） */
  productImages: string[]
  /** main / dimension / detail / scene */
  kind: string
  /** 产品资料里确实有的颜色（用于判断有没有编颜色） */
  colors: string[]
  material: string
  /** 这张图是否要求出现 Logo（现在不做 Logo 检查，保留字段仅为兼容） */
  hasLogo?: boolean
}

/**
 * 跑一次审查。失败不抛错 —— 审查只是附加信息，不能反过来把出图搞挂。
 */
export async function reviewProductImage(
  settings: Settings,
  input: ReviewInput,
  productId?: string | null
): Promise<ImageReviewResult | null> {
  if (!settings.aiApiKey?.trim()) return null
  if (!input.image || !input.productImages.length) return null

  const kindLabel =
    input.kind === 'main'
      ? '主图（纯白底）'
      : input.kind === 'dimension'
        ? '尺寸图（纯白底、有英寸标注）'
        : input.kind === 'detail'
          ? '细节图（材质/结构/功能特写）'
          : input.kind === 'scene'
            ? '场景图（真实使用场景）'
            : input.kind

  const system = `You are a strict product-photography QA reviewer for a US promotional-products catalog.

You receive:
- Image 1 = the AI-GENERATED image to review.
- Images 2..N = the ORIGINAL product photos (ground truth).

Judge ONLY by comparing them. Report each check as pass/fail with a short Chinese note.
Never suggest improvements, never rewrite prompts; only state what is wrong.

Checks (all required):
1. product  产品一致性 — is it the same product as the originals (silhouette, proportions, construction)?
2. color    颜色一致性 — does any colour appear that is NOT in the allowed list and NOT visible in the originals?
   Metal hardware finish counts as colour: silver hardware must not become gold/rose-gold, and vice versa.
3. structure 结构一致性 — was the structure changed (parts added, removed, reshaped, mirrored)?
4. accessory 配件一致性 — were accessories/parts added or removed?
5. scene    场景合理性 — is the usage scene physically plausible (no floating objects, wrong scale, impossible use)?
6. background 背景要求 — main and dimension images MUST be pure white (#FFFFFF) seamless, no gradient, no scenery, no props, no floor line.
   Two allowances for MAIN images only:
   - a row/column of SMALL COLOUR VARIANTS of the SAME product (the ASI colourway layout) is REQUIRED, not a prop:
     judge those variants under checks 2/3/4, do not fail the background because of them.
   - a soft contact shadow directly under the product is acceptable; a long cast shadow, reflection pool or grey floor gradient is not.
   For detail/scene images this check passes automatically.
7. quality  图片质量 — sharp, no blur, no warping, no extra limbs/objects, composition not broken.

NOTE: do NOT evaluate logos at all — the source product is usually logo-free, and any logo is added deliberately afterwards.

Rules:
- If a check cannot be judged from the images, mark it pass with note "无法判断".
- Output STRICT JSON only, no markdown:
{"checks":[{"key":"product","ok":true,"note":"..."}, ... exactly these 7 keys ...]}`

  const allowedColors = input.colors.filter(Boolean).slice(0, 12).join(' / ') || '(未提供)'
  const user = `IMAGE TYPE: ${kindLabel}
ALLOWED COLOURS (only these exist): ${allowedColors}
MATERIAL: ${input.material || '(未提供)'}

Image 1 is the generated image. Images 2-${input.productImages.length + 1} are the original product photos.
Run the 7 checks and output the JSON.`

  try {
    const { data } = await callChatJsonDetailed<{ checks?: Array<{ key?: string; ok?: boolean; note?: string }> }>(
      settings,
      system,
      user,
      0.1,
      [input.image, ...input.productImages.slice(0, 3)],
      { task: 'image-review', productId: productId ?? null }
    )
    const byKey = new Map<string, { ok: boolean; note: string }>()
    for (const c of data.checks ?? []) {
      if (!c?.key) continue
      byKey.set(String(c.key), { ok: c.ok !== false, note: String(c.note ?? '') })
    }
    const checks: ImageReviewCheck[] = CHECKS.map((c) => ({
      key: c.key,
      label: c.label,
      ok: byKey.get(c.key)?.ok ?? true,
      note: byKey.get(c.key)?.note ?? '无法判断',
    }))
    return {
      ok: checks.every((c) => c.ok),
      checks,
      issues: checks.filter((c) => !c.ok).map((c) => `${c.label}：${c.note}`),
      reviewedAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}
