import { Router } from 'express'

type ImageInput = { image: string; role?: string }
type AnalyzeBody = { images?: ImageInput[]; productHint?: string }
type GenerateBody = { images?: ImageInput[]; prompt?: string; size?: '1K' | '2K'; n?: number }

const router = Router()
const timeoutMs = 180_000

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`服务端尚未配置 ${name}`)
  return value
}

function workspaceEndpoint(path: string): string {
  const workspace = required('BAILIAN_WORKSPACE_ID')
  return `https://${workspace}.cn-beijing.maas.aliyuncs.com/api/v1${path}`
}

function validateImages(images: ImageInput[] | undefined): ImageInput[] {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('至少需要提供一张商品参考图')
  }
  if (images.length > 9) throw new Error('单次最多提供 9 张参考图')
  for (const item of images) {
    if (!item || typeof item.image !== 'string' || !/^(https?:\/\/|data:image\/)/i.test(item.image)) {
      throw new Error('图片必须是可访问的 HTTPS URL 或 data:image URL')
    }
  }
  return images
}

async function requestJson(url: string, body: unknown): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${required('DASHSCOPE_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await response.text()
    let data: any
    try { data = JSON.parse(raw) } catch { throw new Error(`百炼接口返回无法解析的内容（HTTP ${response.status}）`) }
    if (!response.ok) {
      const message = data?.message || data?.error?.message || raw.slice(0, 300)
      throw new Error(`百炼接口调用失败（HTTP ${response.status}）：${message}`)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Visual analysis uses Qwen through the OpenAI-compatible Beijing endpoint.
 * Keep model ID configurable because Alibaba Cloud model availability changes by workspace.
 */
router.post('/analyze', async (req, res) => {
  try {
    const body = req.body as AnalyzeBody
    const images = validateImages(body.images)
    const model = process.env.BAILIAN_VISION_MODEL?.trim() || 'qwen-vl-max'
    const content: any[] = [{
      type: 'text',
      text: [
        '你是专业的商品视觉分析师。请分析输入的供应商商品图片，为美国 B2B promotional products 商品图片生产建立事实档案。',
        '只描述图片能够直接证实的事实；无法确认的材质、功能、尺寸、颜色数量必须标记为 unknown。',
        '区分产品真实参考图与风格参考图。识别主体轮廓、结构、部件、颜色、Logo、接口、开合方式和图片用途。',
        '指出图片之间的矛盾、缺失角度、模糊和重复素材。禁止推测未展示的结构。',
        '只输出合法 JSON，不要 Markdown。结构：{product_category, visible_facts:{shape,colors,materials,components,logo,controls,functions}, protected_features:[], assets:[{index,role,quality,reason}], missing_views:[], contradictions:[], recommended_images:[{type,method,required_assets,notes}], confidence}.',
        body.productHint ? `用户提供的商品提示：${body.productHint}` : '',
        '图片按下方顺序编号，从 1 开始。'
      ].filter(Boolean).join('\n'),
    }]
    for (const image of images) content.push({ type: 'image_url', image_url: { url: image.image, detail: 'high' } })
    const data = await requestJson('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是严格的商品视觉事实分析器。绝不编造图片中看不到的信息。' },
        { role: 'user', content },
      ],
    })
    const text = data?.choices?.[0]?.message?.content
    if (!text) throw new Error('视觉模型没有返回分析结果')
    let analysis: unknown
    try { analysis = JSON.parse(text) } catch { throw new Error('视觉模型返回的内容不是合法 JSON，请重试') }
    res.json({ ok: true, model, analysis, usage: data.usage ?? null })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

/**
 * Wan 2.7 image editing/generation. Output URLs are temporary; callers must download
 * and persist them immediately before treating a generation as a completed asset.
 */
router.post('/generate', async (req, res) => {
  try {
    const body = req.body as GenerateBody
    const images = validateImages(body.images)
    const prompt = body.prompt?.trim()
    if (!prompt) throw new Error('请提供图片生成说明')
    if (prompt.length > 4500) throw new Error('图片提示词不能超过 4500 个字符')
    const model = process.env.WAN_IMAGE_MODEL?.trim() || 'wan2.7-image-pro'
    const data = await requestJson(workspaceEndpoint('/services/aigc/multimodal-generation/generation'), {
      model,
      input: {
        messages: [{
          role: 'user',
          content: [
            ...images.map((item) => ({ image: item.image })),
            { text: prompt },
          ],
        }],
      },
      parameters: {
        size: body.size === '1K' ? '1K' : '2K',
        n: Math.max(1, Math.min(1, Number(body.n) || 1)),
        watermark: false,
      },
    })
    const choices = data?.output?.choices ?? []
    const outputImages = choices.flatMap((choice: any) =>
      (choice?.message?.content ?? [])
        .filter((item: any) => item?.type === 'image' && typeof item.image === 'string')
        .map((item: any) => item.image)
    )
    if (!outputImages.length) throw new Error(data?.message || '图片模型没有返回图片地址')
    res.json({ ok: true, model, images: outputImages, warning: '模型返回的图片 URL 可能有时效，请立即下载并保存到 Workbench 图片资产库。' })
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    providers: {
      vision: Boolean(process.env.DASHSCOPE_API_KEY && process.env.BAILIAN_VISION_MODEL !== 'disabled'),
      image: Boolean(process.env.DASHSCOPE_API_KEY && process.env.BAILIAN_WORKSPACE_ID),
    },
    models: {
      vision: process.env.BAILIAN_VISION_MODEL?.trim() || 'qwen-vl-max',
      image: process.env.WAN_IMAGE_MODEL?.trim() || 'wan2.7-image-pro',
    },
    region: 'cn-beijing',
  })
})

export const aiImageStudioRouter = router
