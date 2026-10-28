import { SourceInfo } from '../types'
import { callChatJson } from './ai'

/**
 * 图像 Prompt 编排：
 * 1. 文本模型（现有 AI）分析 1688 产品信息 + 图片 → 产出 5 张图的英文构图 Prompt
 * 2. 对话式改图：文本模型把用户的中文修改意图翻译成精确的英文图像编辑指令
 */

export interface ImagePromptSet {
  /** 主图：主产品 + 其他颜色缩略图（下方/右侧）+ Logo 融合，无文字 */
  main: string
  /** 尺寸图：干净产品图（后端程序化叠加 inch 标注，AI 不画数字） */
  dimension: string
  /** 介绍图 1-3：特点卖点 / 使用场景 */
  intro: string[]
}

interface RawPromptSet {
  main?: string
  dimension?: string
  intro?: string[]
}

const SYSTEM = `You are a prompt engineer for AI product photography (gpt-image-1).
You convert 1688 product data into precise English image-generation prompts for a US promotional-products (ASI) listing.

Rules for every prompt:
- Photorealistic commercial product photography, studio lighting, clean seamless background.
- The product must look EXACTLY like the reference images (same shape, proportions, materials, colors). Never invent a different product.
- ABSOLUTELY NO TEXT, letters, numbers, watermarks, or logos in the image EXCEPT the user's brand logo when explicitly instructed to blend it onto the product.
- Keep composition uncluttered; leave breathing room around the product.

Output STRICT JSON only:
{"main":"<prompt>","dimension":"<prompt>","intro":["<prompt1>","<prompt2>","<prompt3>"]}

Prompt requirements per image:
- "main": Hero shot. The main product large and centered; smaller thumbnails of the SAME product in its other available colors arranged below or to the right of the main product (a neat grid/row, evenly spaced, same scale). The user's logo (provided as the LAST reference image) is blended naturally onto the FRONT of the main product, like a real factory imprint — correct perspective, subtle texture, not a floating sticker. No text anywhere else.
- "dimension": A single clean product shot, straight-on angle, centered on pure white background, generous margins on all sides (the system will overlay dimension lines programmatically). NO dimension lines, NO arrows, NO numbers, NO text.
- "intro": 3 lifestyle/context prompts showcasing selling points and usage scenarios (e.g. office, outdoor, gift-giving). Each prompt must describe ONE scene, photorealistic, no text.`

export async function buildImagePromptSet(
  source: SourceInfo,
  settings: Parameters<typeof callChatJson>[0]
): Promise<ImagePromptSet> {
  const productFacts = [
    `Product title: ${source.sourceTitle}`,
    `Description: ${source.description?.slice(0, 1500)}`,
    `Material: ${source.materialCn}`,
    `Colors: ${source.colorsCn}`,
    `Size: ${source.sizeCn}`,
    `Category: ${source.category}`,
    `Notes: ${source.notes}`,
  ]
    .filter(Boolean)
    .join('\n')

  const user = `Create the 5 image prompts for this 1688 product.

PRODUCT FACTS:
${productFacts}

The reference images (if any) show the real product. The LAST reference image (if provided) is the user's brand logo to blend onto the product front in the "main" prompt only.`

  const images = (source.images ?? []).filter((u) => /^https?:\/\//.test(u)).slice(0, 4)
  const raw = await callChatJson<RawPromptSet>(
    settings,
    SYSTEM,
    user,
    0.5,
    images.length ? images : undefined
  )

  const intro = (raw.intro ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
  while (intro.length < 3) {
    intro.push(
      `Photorealistic lifestyle photo of the ${source.sourceTitle || 'product'} in a bright modern office desk setting, shallow depth of field, no text.`
    )
  }
  return {
    main: String(raw.main ?? '').trim() || fallbackMain(source),
    dimension:
      String(raw.dimension ?? '').trim() ||
      `A single ${source.sourceTitle || 'product'} photographed straight-on, centered on a pure white seamless background, studio lighting, generous empty margins around the product, photorealistic, no text, no lines, no numbers.`,
    intro,
  }
}

function fallbackMain(source: SourceInfo): string {
  return `Hero product photography of the ${source.sourceTitle || 'product'} exactly as shown in the reference images, large and centered, with smaller thumbnails of the same product in its other color variants arranged in a neat row below it, the brand logo from the last reference image blended naturally onto the front of the main product like a real factory imprint, studio lighting, clean light-gray seamless background, photorealistic, no text anywhere.`
}

/**
 * 对话式改图：把用户中文修改意图 + 图片历史 → 精确英文编辑指令。
 * 返回英文编辑 prompt（用于 images/edits）+ 给用户看的中文说明。
 */
export async function translateImageEditInstruction(
  userMessage: string,
  currentPrompt: string,
  kind: string,
  settings: Parameters<typeof callChatJson>[0]
): Promise<{ editPrompt: string; reply: string }> {
  const system = `You translate a user's image-editing request into a precise English instruction for an image-editing model (gpt-image-1 edits).
The image is part of a promotional-product listing (${kind} image).

Rules:
- The edit must PRESERVE the product's identity: same product, same shape, same materials. Only change what the user asked.
- Never add text/letters/numbers unless the user explicitly asks.
- Output STRICT JSON: {"editPrompt":"<full English edit instruction>","reply":"<1-2 sentence Chinese confirmation of what you changed>"}`

  const user = `CURRENT IMAGE PROMPT (context):
${currentPrompt}

USER REQUEST (Chinese, translate the intent):
${userMessage}`

  const raw = await callChatJson<{ editPrompt?: string; reply?: string }>(
    settings,
    system,
    user,
    0.4
  )
  return {
    editPrompt: String(raw.editPrompt ?? userMessage).trim(),
    reply: String(raw.reply ?? '已按您的要求修改图片。').trim(),
  }
}
