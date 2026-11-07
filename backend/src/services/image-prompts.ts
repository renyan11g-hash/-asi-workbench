import { SourceInfo } from '../types'
import { callChatJson } from './ai'

/**
 * 图像 Prompt 编排：
 * 1. 文本模型（现有 AI）分析 1688 产品信息 + 图片 → 产出 5 张图的英文构图 Prompt
 * 2. 对话式改图：文本模型把用户的中文修改意图翻译成精确的英文图像编辑指令
 */

export interface ImagePromptSet {
  /** 主图：主产品 + 其他颜色缩略图（下方/右侧）+ Logo 融合，无文字；combo 时带卖点特写组合 */
  main: string
  /** 尺寸图：干净产品图（后端程序化叠加 inch 标注，AI 不画数字） */
  dimension: string
  /** 细节图 1-2：真实材质 / 结构 / 功能特写 */
  detail: string[]
  /** 场景图 1-2：真实使用场景 */
  scene: string[]
}

interface RawPromptSet {
  main?: string
  dimension?: string
  detail?: string[]
  scene?: string[]
}

export interface PromptOptions {
  /** 生图前读到的产品资料（特点/颜色/材质/场景） */
  productInfo?: string
  /** 参考图张数（只学构图光线场景，严禁改产品） */
  styleRefCount?: number
  /** 主图样式：white=纯白底单主图；combo=产品+卖点组合展示 */
  mainStyle?: 'white' | 'combo'
  withDetail?: boolean
  withScene?: boolean
}

const SYSTEM = `You are a prompt engineer for AI product photography (gpt-image-1).
You convert 1688 product data into precise English image-generation prompts for a US promotional-products (ASI) listing.

Rules for every prompt:
- Photorealistic commercial product photography, studio lighting.
- PRODUCT FIDELITY IS THE HIGHEST PRIORITY. The generated product must be indistinguishable from the reference photos:
  identical silhouette and proportions, identical construction details (seams, stitching, zippers, pulls, buckles, handles, mesh panels, pockets, hardware), identical material sheen and texture, identical colour.
  Never beautify or redesign: no restyling, no simplification, no added or removed parts, no colour shift, no mirrored image, no change of material or finish.
  If something is not visible in the reference images, do not invent it.
- BACKGROUND: every "main" and "dimension" image sits on a PURE WHITE background (#FFFFFF, RGB 255,255,255):
  seamless, flat, no gradient, no vignette, no grey sweep, no floor line, no coloured backdrop, no scenery, no reflection pool.
  A soft contact shadow directly under the product is acceptable, but the background itself must stay pure white.
- ABSOLUTELY NO TEXT, letters, numbers, dimension lines, rulers, arrows, watermarks, labels, badges or logos in the image,
  EXCEPT the user's brand logo when explicitly instructed to blend it onto the product.
- LOGO HANDLING — obey the "LOGO:" directive in the user message:
  * "LOGO: none" → the main image must NOT contain any logo, brand mark, or imprint anywhere; the product stays completely clean.
  * Otherwise → the user's logo (provided as the LAST reference image) is blended onto the product as described in the "main" rules below.
- Keep composition uncluttered; leave breathing room around the product.
- If the user message contains a "USER NOTES" block, those are the client's hard requirements (composition, colours, which variant to show, where the logo goes, background, etc.). Follow them STRICTLY in the affected prompts; they override the defaults above (but still never add text/numbers or invented content).

Output STRICT JSON only:
{"main":"<prompt>","dimension":"<prompt>","detail":["<prompt1>","<prompt2>"],"scene":["<prompt1>","<prompt2>"]}

Prompt requirements per image:
- "main": HERO + COLOUR VARIANTS, all on a PURE WHITE seamless background.
  * One hero product in its primary colour, the largest object in the frame, slightly above centre, filling roughly 55-65% of the frame height.
  * The SAME product in its other available colours shown as SMALLER thumbnails: a horizontal row below the hero, or a vertical column to the right of it when the hero is tall and narrow.
    Each thumbnail: same camera angle, same lighting, same white background, evenly spaced, aligned, never overlapping the hero or each other, each about 25-30% of the hero's height.
    Only colours that are actually listed for this product — never invent colourways.
  * The rest of the canvas stays empty pure white. Optionally ONE small close-up detail inset of the SAME product in a corner (to hint a feature) if it does not crowd the colour thumbnails; never overlap them, never add text to it.
  * No props, no models, no packaging, no dimensions, no text.
  * LOGO: if "LOGO: none" the product front stays completely clean. Otherwise blend the user's logo (LAST reference image) onto the FRONT of the HERO product only, like a real factory imprint — correct perspective and curvature, subtle fabric/material texture, not a floating sticker. Not on the colour thumbnails. The logo MUST be clearly visible against the product colour: on a dark product recolour the logo artwork to WHITE (or another high-contrast light tone); on a light product keep it dark or in its original colours. Only the logo's colour may change for contrast — its shape and content stay identical.
  * SUPPLIER MARKS: if the original product in the reference photos carries a manufacturer / supplier logo, brand name, printed text or any factory mark, it MUST be removed completely in the generated image (clean, unmarked surface). The ONLY mark allowed on the product is the user's logo, and only when the LOGO directive says so.
- "dimension": ONE product only, on a PURE WHITE background, for a technical specification shot.
  * Camera perfectly level with the product centre, straight-on orthographic front view: no perspective distortion, no tilt, no foreshortening, no wide-angle stretch. The product stands upright and square to the camera.
  * The product is fully visible and centred, occupying about 60-70% of the frame, with a GENEROUS empty white margin on ALL FOUR sides (at least 12% of the frame width/height each). Nothing may touch or bleed off the edges — dimension lines and labels are drawn into that margin afterwards by the system.
  * Do NOT draw dimension lines, arrows, rulers, numbers, labels or text of any kind. No protractor, no grid, no measuring props.
  * Same fidelity rule as above: the product must look exactly like the reference, not a redrawn or idealized version.
- "detail": 1-2 extreme close-up prompts showing the PRODUCT'S REAL material texture, construction seams, functional mechanism and hardware.
  * Macro lens look, shallow depth of field, soft studio light, neutral or pure white background.
  * Show only what is actually visible in the reference photos — never invent stitching, ridges, ports, buttons, logos or accessories.
  * No text, no numbers, no dimension lines, no props.
- "scene": 1-2 realistic lifestyle prompts of the product being used in a plausible setting that matches its real use case.
  * The product must stay identical (shape, colour, material, parts, scale relative to hands/objects).
  * Physically plausible: rests on a surface / held naturally, correct scale, correct gravity, no floating, no impossible use, no extra products.
  * Natural light mixed with soft fill, photorealistic, no text.

STYLE REFERENCES (when provided) are DIFFERENT products used only to learn composition, layout, lighting, colour grading and scene treatment.
Never copy their product, parts, accessories, colours, material or proportions into our product.`

export async function buildImagePromptSet(
  source: SourceInfo,
  settings: Parameters<typeof callChatJson>[0],
  /** 生成前用户注意事项（中文，可空）：融入 Prompt 编排，AI 必须遵循 */
  userNotes?: string,
  /** 主图是否融合品牌 Logo（false=干净产品图，禁止出现任何 Logo） */
  withLogo = true,
  /** V2：产品资料、参考图、主图样式、要哪些图种 */
  opts?: PromptOptions
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

  const notes = (userNotes ?? '').trim()
  const notesBlock = notes
    ? `
USER NOTES (client's hard requirements, MUST follow):
${notes}
`
    : ''
  const logoDirective = withLogo
    ? `LOGO: blend the user's brand logo (the LAST reference image) onto the product front in the "main" prompt only.`
    : `LOGO: none — the "main" prompt must describe a completely clean product with NO logo, brand mark, or imprint anywhere.`
  const user = `Create the image prompts for this 1688 product.

PRODUCT FACTS:
${productFacts}
${opts?.productInfo ? `\nSTRUCTURED PRODUCT DATA (read this before writing prompts — features / colours / material / usage):\n${opts.productInfo}\n` : ''}${notesBlock}
${logoDirective}
${opts?.styleRefCount ? `STYLE REFERENCES: the LAST ${opts.styleRefCount} reference image(s) are style references only (composition, layout, lighting, background treatment). They may be DIFFERENT products. Never copy their product; only borrow the photographic style.` : ''}
IMAGE SET REQUESTED: ${[opts?.withDetail !== false ? 'detail' : '', opts?.withScene !== false ? 'scene' : ''].filter(Boolean).join(' + ') || 'main + dimension'}
MAIN STYLE: ${opts?.mainStyle === 'combo' ? 'combo (hero + selling-point close-up insets, still pure white)' : 'white (single hero + colour variants)'}
The reference images (if any) show the real product.${withLogo ? ' The LAST reference image (if provided) is the user\'s brand logo to blend onto the product front in the "main" prompt only.' : ' No logo reference image is provided — do not include any logo in any prompt.'}`

  const images = (source.images ?? [])
    .filter((u) => /^(https?:\/\/|data:image\/)/i.test(u))
    .slice(0, 6)
  const raw = await callChatJson<RawPromptSet>(
    settings,
    SYSTEM,
    user,
    0.5,
    images.length ? images : undefined
  )

  const detailRaw = (raw.detail ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 2)
  const sceneRaw = (raw.scene ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 2)
  while (detailRaw.length < 2) detailRaw.push(fallbackDetail(source, detailRaw.length))
  while (sceneRaw.length < 1) sceneRaw.push(fallbackScene(source))
  return {
    main: String(raw.main ?? '').trim() || fallbackMain(source, withLogo),
    dimension: String(raw.dimension ?? '').trim() || fallbackDimension(source),
    detail: detailRaw,
    scene: sceneRaw,
  }
}

function fallbackDetail(source: SourceInfo, index: number): string {
  const angles = [
    'a tight macro close-up of the material texture and construction seams',
    'a close-up showing the functional mechanism and hardware details',
  ]
  return `Extreme close-up product detail photo of the ${source.sourceTitle || 'product'} reproduced exactly as in the reference photos — ${angles[index % angles.length]}, identical colour and finish, shallow depth of field, soft studio lighting, neutral background, photorealistic, no text, no numbers, no props, no invented parts.`
}

function fallbackScene(source: SourceInfo): string {
  return `Photorealistic lifestyle photo of the ${source.sourceTitle || 'product'} being used in a realistic everyday setting that matches its real use case, natural light mixed with soft studio fill, product clearly visible and accurate to the reference photos (same shape, colour, material, parts), no text, no numbers, no floating objects, no exaggerated scale.`
}

function fallbackMain(source: SourceInfo, withLogo = true): string {
  const logoPart = withLogo
    ? ', the brand logo from the last reference image blended naturally onto the front of the hero product like a real factory imprint (correct perspective, not a sticker; if the product is dark the logo is rendered white for contrast)'
    : ', completely clean product front with no logo, brand mark, or imprint anywhere'
  return `Commercial product photography of the ${source.sourceTitle || 'product'} reproduced exactly as in the reference photos — identical shape, proportions, construction details and colour, no redesign. One hero product in its main colour, large, slightly above centre; the same product in its other available colours as smaller evenly spaced thumbnails in a row below the hero (or a column to its right), each about a quarter of the hero's height and never overlapping it${logoPart}. Pure white seamless background (#FFFFFF, no gradient, no grey sweep), soft contact shadow only, studio lighting, no text, no numbers, no dimension lines, no props.`
}

function fallbackDimension(source: SourceInfo): string {
  return `Technical specification photo of the ${source.sourceTitle || 'product'} reproduced exactly as in the reference photos (identical shape, proportions and details), a single item standing upright, camera perfectly level, straight-on orthographic front view with no perspective distortion, centred and fully visible on a pure white seamless background (#FFFFFF), generous empty white margin on all four sides (at least 12% of the frame), soft contact shadow only, studio lighting, photorealistic. Absolutely no dimension lines, no arrows, no rulers, no numbers, no text, no labels.`
}

/**
 * 介绍图文字建议：不生成图片（省 AI 费用），由文本模型产出 3 条介绍图拍摄/构图建议
 * （中文，可直接复制给美工或 AI 绘图工具使用）。
 */
export async function buildIntroSuggestions(
  source: SourceInfo,
  settings: Parameters<typeof callChatJson>[0]
): Promise<string[]> {
  const system = `You are a creative director for promotional-product (ASI) listing photos.
Based on the 1688 product data, write exactly 3 suggestions for LIFESTYLE/CONTEXT photos (介绍图).
Each suggestion: 1-2 sentences in CHINESE, describing scene + model action + what selling point it shows.
Be concrete and shootable (e.g. "健身房场景：模特擦汗时展示毛巾速干，突出吸汗快干卖点").
Output STRICT JSON: {"suggestions":["<1>","<2>","<3>"]}`

  const user = `PRODUCT FACTS:
- Title: ${source.sourceTitle}
- Description: ${source.description?.slice(0, 800) || ''}
- Material: ${source.materialCn}
- Colors: ${source.colorsCn}
- Category: ${source.category}
- Notes: ${source.notes}

Write 3 lifestyle photo suggestions that showcase this product's selling points for a US B2B promotional-products listing.`

  const raw = await callChatJson<{ suggestions?: string[] }>(settings, system, user, 0.6)
  const list = (raw.suggestions ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
  while (list.length < 3) {
    list.push(`${source.sourceTitle || '产品'}使用场景图：展示核心卖点（可让美工按此拍摄或用 AI 生成）。`)
  }
  return list
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
