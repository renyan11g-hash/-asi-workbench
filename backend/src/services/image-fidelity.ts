import { createHash } from 'crypto'
import type { ProductImageKind, SourceInfo } from '../types'

/**
 * 产品保真 · 独立规则层（与「好不好看」完全分开）。
 *
 * 图片模型再强也会「美化」：改结构、加配件、换颜色、把参考图里的别的产品混进来。
 * 这里把「不可妥协的产品事实」写成固定英文条款，**每一张实际发给模型的 prompt 末尾
 * 都必须拼上 guardPrompt()**；同时导出可单测的纯函数（不调 AI、不读库），
 * 让「保真」有自己的测试，而不是靠人眼看图觉得好看就算过。
 */

export interface FidelityRule {
  id: string
  /** 给测试/日志看的短标签 */
  label: string
  /** 实际写进 prompt 的英文条款 */
  text: string
}

export const FIDELITY_RULES: FidelityRule[] = [
  {
    id: 'structure',
    label: '不改变产品结构',
    text: 'Do not change the product structure: same silhouette, same proportions, same seams, panels, folds and openings.',
  },
  {
    id: 'color',
    label: '不改变真实颜色',
    text: 'Do not change the real colour. Use only colours visible in the supplied product photos; never invent, shift or "improve" a colourway.',
  },
  {
    id: 'accessory',
    label: '不增加或删除配件',
    text: 'Do not add, remove, merge or relocate any part, accessory, strap, buckle, zipper, pocket, button, label or packaging item.',
  },
  {
    id: 'logo',
    label: '不改变 Logo 及位置',
    text: 'Do not alter any logo, imprint, embossing or print: keep its shape, wording and position exactly as shown, except the user brand logo that is explicitly requested for the main image.',
  },
  {
    id: 'function',
    label: '不虚构功能',
    text: 'Do not invent functions, mechanisms, openings, ports, controls or features that are not clearly visible in the product photos.',
  },
  {
    id: 'surface',
    label: '不虚构纹理材质',
    text: 'Do not invent texture, stitching, grain, weave, gloss or material; reproduce the real surface exactly (matte stays matte, leather stays leather, fabric stays fabric).',
  },
  {
    id: 'proportion',
    label: '不改变比例',
    text: 'Do not change relative proportions or scale between parts; the product must measure the same in the image as in the reference photos.',
  },
  {
    id: 'cross_product',
    label: '不混入参考图产品',
    text: 'Never copy any product, part, accessory, colour or material from a STYLE reference image into our product. Style references are NOT product references.',
  },
  {
    id: 'unconfirmed',
    label: '不写未经确认的参数',
    text: 'Do not render numbers, dimensions, specifications, badges or claims that were not explicitly supplied as confirmed data.',
  },
  {
    id: 'uncertain',
    label: '不确定就保留原样',
    text: 'When a detail is uncertain or hidden, keep it as in the original photo or leave it out; never guess or complete it.',
  },
]

/** 风格参考图的边界条款（有风格参考图时才拼） */
export const STYLE_REF_CLAUSE = `STYLE REFERENCES (the last reference image(s), up to 2) are DIFFERENT products.
Use them ONLY for composition, camera angle, lighting, shadow softness, background treatment, colour grading, whitespace and layout.
Do NOT copy their product, parts, accessories, colours, materials, text, logos or proportions. Our product must remain exactly the product in the FIRST product reference image(s).`

/**
 * 给任何一张图的 prompt 追加保真护栏。返回的文本永远以 FIDELITY BLOCK 结尾，
 * 模型对末尾指令更敏感，这是有意的。
 */
export function guardPrompt(
  basePrompt: string,
  opts: { kind: ProductImageKind | string; withStyleRefs?: boolean; withLogo?: boolean }
): string {
  const rules = FIDELITY_RULES.map((r, i) => `${i + 1}. [${r.id}] ${r.text}`).join('\n')
  const logoLine = opts.withLogo
    ? 'The only permitted mark is the user brand logo explicitly requested for this image; blend it without changing its artwork.'
    : 'No logo, brand mark, watermark or imprint may appear anywhere in this image.'
  const styleLine = opts.withStyleRefs ? `\n${STYLE_REF_CLAUSE}` : ''
  return `${basePrompt.trim()}

PRODUCT FIDELITY (non-negotiable, highest priority — apply to every part of the image):
${rules}
${logoLine}${styleLine}
If any instruction above conflicts with making the image look nicer, PRODUCT FIDELITY WINS.`
}

/** 检查一条 prompt 是否带齐 10 条保真规则（测试与运行时自检共用） */
export function missingFidelityRules(prompt: string): string[] {
  return FIDELITY_RULES.filter((r) => !prompt.includes(`[${r.id}]`)).map((r) => r.id)
}

/** prompt 版本号：反馈要能追溯到「当时用的是哪版提示词」 */
export function promptVersionOf(prompt: string): string {
  return `pv-${createHash('sha1').update(prompt).digest('hex').slice(0, 10)}`
}

/* ------------------------------------------------------------------ */
/* 自动拍摄套图规划：不机械套固定张数，按产品特点决定                     */
/* ------------------------------------------------------------------ */

export interface ShotPlan {
  kinds: ProductImageKind[]
  detailCount: number
  sceneCount: number
  /** 给用户看的中文理由（界面显示「为什么这样配」） */
  reasons: string[]
}

const TEXTURE_RICH = /皮|革|布|棉|麻|绒|针织|编织|木|竹|金属|不锈钢|铝|陶瓷|玻璃|硅胶|leather|canvas|cotton|knit|metal|steel|wood|ceramic|glass/i
const SCENE_GOOD = /杯|壶|包|袋|盒|灯|音箱|音响|伞|帽|衣|服|巾|笔|本|收纳|工具|户外|旅行|办公|bottle|tumbler|bag|speaker|light|umbrella|apparel|outdoor|travel|office/i

/**
 * 产品特点 → 建议图片组合。
 * 主图永远有；有确认尺寸才出尺寸图（尺寸图数字必须是真的，不能猜）；
 * 材质/结构复杂或有多角度产品图 → 2 张细节图；有明确使用场景 → 1 张场景图。
 */
export function planShotSet(input: {
  title?: string
  category?: string
  material?: string
  colors?: string
  imageCount?: number
  hasDimensions?: boolean
  /** 用户明确要求「只要主图」等 */
  forceKinds?: ProductImageKind[]
}): ShotPlan {
  if (input.forceKinds?.length) {
    const kinds = input.forceKinds.filter((k, i, arr) => arr.indexOf(k) === i)
    return {
      kinds,
      detailCount: kinds.filter((k) => k === 'detail').length,
      sceneCount: kinds.filter((k) => k === 'scene').length,
      reasons: ['按你手动选择的图种生成'],
    }
  }
  const hay = `${input.title ?? ''} ${input.category ?? ''} ${input.material ?? ''} ${input.colors ?? ''}`
  const reasons: string[] = ['主图：ASI 商品页第一张，纯白底突出产品本体']
  const kinds: ProductImageKind[] = ['main']

  if (input.hasDimensions) {
    kinds.push('dimension')
    reasons.push('尺寸图：已有确认尺寸，程序化标注数字，保证准确')
  } else {
    reasons.push('尺寸图：未录入确认尺寸，先不出（不猜数字）')
  }

  const colorCount = (input.colors ?? '')
    .split(/[/,，、;；|]/)
    .map((s) => s.trim())
    .filter(Boolean).length
  const textureRich = TEXTURE_RICH.test(hay)
  const detailCount = textureRich || colorCount > 1 || (input.imageCount ?? 0) >= 4 ? 2 : 1
  for (let i = 0; i < detailCount; i++) kinds.push('detail')
  reasons.push(
    detailCount === 2
      ? '细节图 ×2：材质/结构信息多（多颜色或多角度实拍），需要展示纹理与做工'
      : '细节图 ×1：展示真实材质与关键结构'
  )

  const sceneCount = SCENE_GOOD.test(hay) ? 1 : 0
  if (sceneCount) {
    kinds.push('scene')
    reasons.push('场景图 ×1：有明确使用场景，帮助美国买家代入（商务/办公/礼品）')
  } else {
    reasons.push('场景图：产品使用场景不明确，暂不生成，避免虚构使用方式')
  }
  return { kinds, detailCount, sceneCount, reasons }
}

/* ------------------------------------------------------------------ */
/* 图像模型能力探测：不假设所有模型都支持多参考图                         */
/* ------------------------------------------------------------------ */

export interface ImageCapabilities {
  provider: string
  model: string
  multiRef: boolean
  supportsEdit: boolean
  /** 单次请求最多几张参考图（含 Logo） */
  maxRefs: number
  /** 一句话说明，直接显示在界面 */
  note: string
}

export function capabilitiesFor(baseUrl: string, model: string): ImageCapabilities {
  const m = (model || '').trim() || 'doubao-seedream-4-0-250828'
  if (/volces\.com/i.test(baseUrl || '') || /seedream|seededit/i.test(m)) {
    return {
      provider: '火山方舟 Ark（Seedream）',
      model: m,
      multiRef: true,
      supportsEdit: true,
      maxRefs: 10,
      note: '支持多参考图 + 指令编辑；参考图可直传 URL 或 base64。产品图放前面、风格参考图放最后 1-2 张。',
    }
  }
  if (/openai|gpt-image|dall-e/i.test(`${baseUrl} ${m}`)) {
    return {
      provider: 'OpenAI 兼容（gpt-image / DALL·E）',
      model: m,
      multiRef: true,
      supportsEdit: true,
      maxRefs: 4,
      note: '有参考图时走 /images/edits（multipart）；gpt-image-1 建议 ≤4 张参考图，多了容易改变产品。',
    }
  }
  return {
    provider: '兼容接口',
    model: m,
    multiRef: false,
    supportsEdit: false,
    maxRefs: 1,
    note: '未识别的服务商：按「最多 1 张参考图、不支持编辑」的保守方式处理；如果它其实支持多图，可在设置里换成已识别服务商。',
  }
}

/**
 * 参考图预算：产品图优先，风格参考图最多 2 张，Logo 最后。
 * 超出模型上限就截断风格参考图（绝不截断产品图或 Logo）。
 */
export function budgetRefs(
  caps: ImageCapabilities,
  counts: { product: number; style: number; logo: boolean }
): { product: number; style: number; logo: boolean } {
  const max = Math.max(1, caps.maxRefs)
  const logo = counts.logo && max >= 2
  let product = Math.min(counts.product, logo ? max - 1 : max)
  const room = max - product - (logo ? 1 : 0)
  const style = Math.max(0, Math.min(counts.style, room, 2))
  return { product, style, logo }
}

export function sourceToPlanInput(
  source: SourceInfo,
  extra: { hasDimensions?: boolean } = {}
): Parameters<typeof planShotSet>[0] {
  return {
    title: source.sourceTitle,
    category: source.category,
    material: source.materialCn,
    colors: source.colorsCn,
    imageCount: (source.images ?? []).filter((u) => /^(https?:\/\/|data:image\/)/i.test(u)).length,
    hasDimensions: extra.hasDimensions,
  }
}
