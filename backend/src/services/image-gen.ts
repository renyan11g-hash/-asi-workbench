import { Settings } from '../types'
import { AiError } from './ai'

/**
 * 图像生成服务 —— 双协议：
 * 1. 火山引擎（即梦 Seedream 4.0，国内直连，默认）：
 *    POST https://ark.cn-beijing.volces.com/api/v3/images/generations
 *    body: { model, prompt, image?: string[]（参考图 URL/base64）, size, response_format: 'url' }
 *    Seedream 4.0 支持多参考图（产品图 + Logo）与指令编辑，返回图片 URL。
 * 2. OpenAI 兼容（gpt-image-1 / dall-e-3）：
 *    - generations（JSON）+ edits（multipart，多参考图）
 *
 * 通过 imageBaseUrl 是否包含 volces.com 自动识别协议。
 */

export type ImageSettings = Pick<
  Settings,
  'imageBaseUrl' | 'imageApiKey' | 'imageModel' | 'imageSize' | 'imageQuality'
>

/** 参考图：URL（1688 产品图直传，火山免下载）或 Buffer（Logo） */
export type ImageRef = { url: string } | { buffer: Buffer }

interface ArkImageResponse {
  data?: Array<{ url?: string; b64_json?: string; size?: string }>
  error?: { message?: string; code?: string }
}

/** 图像生成耗时较长，默认 10 分钟 */
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS) || 600_000

function assertConfig(settings: ImageSettings): { base: string; key: string; model: string } {
  // 容错：用户可能粘贴完整端点（…/images/generations），自动去掉后缀再拼接
  const base = (
    settings.imageBaseUrl?.trim() || 'https://ark.cn-beijing.volces.com/api/v3'
  ).replace(/\/images\/(generations|edits)\/?$/i, '')
  const key = settings.imageApiKey?.trim() || ''
  const model = settings.imageModel?.trim() || 'doubao-seedream-4-0-250828'
  if (!key) {
    throw new AiError(
      '尚未配置图像服务 API Key',
      '请到「设置 → 图像生成」填写 API Key（火山引擎在 console.volcengine.com/ark 开通，支付宝充值）。'
    )
  }
  return { base, key, model }
}

const isArk = (baseUrl: string) => /volces\.com/i.test(baseUrl)

function friendlyImageError(status: number, raw: string): AiError {
  if (status === 401 || status === 403)
    return new AiError(
      `图像接口鉴权失败 (${status})：API Key 无效或没有权限`,
      '请到「设置 → 图像生成」检查 API Key；火山引擎需先在方舟控制台开通模型并创建 API Key。'
    )
  if (status === 404)
    return new AiError(
      '图像接口地址不可用 (404) 或模型不存在',
      '火山引擎 Base URL 用 https://ark.cn-beijing.volces.com/api/v3 ；模型 ID 需与方舟控制台开通的一致（如 doubao-seedream-4-0-250828）。'
    )
  if (status === 429) {
    // 火山方舟 429 细分：ModelNotOpen（模型未开通）/ QuotaExceeded（额度不足）/ AccessRateLimit（请求频繁）
    let code = ''
    let detail = ''
    try {
      const j = JSON.parse(raw) as { error?: { code?: string; message?: string } }
      code = j.error?.code || ''
      detail = j.error?.message || ''
    } catch {
      /* 非 JSON 响应，忽略 */
    }
    const lower = (code + ' ' + detail).toLowerCase()
    if (/not\s*open|notopen/.test(lower))
      return new AiError(
        `模型未开通 (429 ${code})：${detail || '当前账号未开通该模型'}`,
        '到火山方舟控制台「模型广场」找到该模型点「开通服务」，开通后即可调用。'
      )
    if (/quota|balance|arrears|insufficient|欠费|余额/.test(lower))
      return new AiError(
        `额度不足 (429 ${code})：${detail || '免费额度已用完或账户余额不足'}`,
        '到火山方舟控制台查看免费额度/余额，不足时充值（支持支付宝）。'
      )
    return new AiError(
      `图像接口限流 (429 ${code || 'AccessRateLimit'})：${detail || '请求过于频繁'}`,
      '稍等 1-2 分钟再试；若持续出现，检查模型并发额度或账户余额。'
    )
  }
  if (status >= 500)
    return new AiError('图像服务商故障 (' + status + ')', '服务商侧问题，稍后重试即可。')
  return new AiError(`图像生成失败 (${status})：${raw.slice(0, 300)}`)
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new AiError(`下载生成图片失败 (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

/** 火山引擎 Ark：images/generations（JSON，image 数组即参考图/编辑指令图） */
async function arkGenerate(
  settings: ImageSettings,
  prompt: string,
  refs: ImageRef[]
): Promise<Buffer> {
  const { base, key, model } = assertConfig(settings)
  const url = `${base.replace(/\/+$/, '')}/images/generations`

  // 火山参考图：https URL 直传；Buffer 转 base64 dataURL
  const imageParam = refs
    .map((r) => ('url' in r ? r.url : `data:image/png;base64,${r.buffer.toString('base64')}`))
    .slice(0, 10) // Seedream 4.0 最多 10 张参考图

  const body: Record<string, unknown> = {
    model,
    prompt,
    response_format: 'url',
    size: settings.imageSize || '2K',
    watermark: false,
  }
  if (imageParam.length) body.image = imageParam

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof Error && err.name === 'AbortError')
      throw new AiError('图像生成超时（超过 10 分钟）', '稍后重试。')
    throw new AiError(`无法连接图像服务：${msg}`, '请检查图像 Base URL 与网络。')
  } finally {
    clearTimeout(timer)
  }

  const raw = await res.text()
  if (!res.ok) throw friendlyImageError(res.status, raw)
  let data: ArkImageResponse
  try {
    data = JSON.parse(raw) as ArkImageResponse
  } catch {
    throw new AiError(`图像接口返回无法解析：${raw.slice(0, 200)}`)
  }
  if (data.error?.message) throw new AiError(`图像接口错误：${data.error.message}`)
  const item = data.data?.[0]
  if (item?.url) return downloadImage(item.url)
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64')
  throw new AiError('图像接口未返回图片数据，请重试')
}

/** OpenAI 兼容：generations（文生图） */
async function openaiGenerate(settings: ImageSettings, prompt: string): Promise<Buffer> {
  const { base, key, model } = assertConfig(settings)
  const url = `${base.replace(/\/+$/, '')}/images/generations`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: settings.imageSize || '1024x1024',
        quality: settings.imageQuality || 'high',
      }),
      signal: controller.signal,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof Error && err.name === 'AbortError')
      throw new AiError('图像生成超时（超过 10 分钟）', '可把质量调为 medium 后重试。')
    throw new AiError(`无法连接图像服务：${msg}`, '请检查图像 Base URL 与网络。')
  } finally {
    clearTimeout(timer)
  }

  const raw = await res.text()
  if (!res.ok) throw friendlyImageError(res.status, raw)
  let data: ArkImageResponse
  try {
    data = JSON.parse(raw) as ArkImageResponse
  } catch {
    throw new AiError(`图像接口返回无法解析：${raw.slice(0, 200)}`)
  }
  if (data.error?.message) throw new AiError(`图像接口错误：${data.error.message}`)
  const item = data.data?.[0]
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64')
  if (item?.url) return downloadImage(item.url)
  throw new AiError('图像接口未返回图片数据，请重试')
}

/** OpenAI 兼容：edits（multipart 多参考图） */
async function openaiEdit(
  settings: ImageSettings,
  prompt: string,
  refs: ImageRef[]
): Promise<Buffer> {
  const { base, key, model } = assertConfig(settings)
  const url = `${base.replace(/\/+$/, '')}/images/edits`
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', prompt)
  form.append('n', '1')
  form.append('size', settings.imageSize || '1024x1024')
  form.append('quality', settings.imageQuality || 'high')
  for (const r of refs) {
    if ('buffer' in r) {
      form.append('image[]', new Blob([new Uint8Array(r.buffer)]), 'reference.png')
    } else {
      const imgRes = await fetch(r.url, { signal: AbortSignal.timeout(30_000) })
      if (!imgRes.ok) continue
      const buf = Buffer.from(await imgRes.arrayBuffer())
      form.append('image[]', new Blob([new Uint8Array(buf)]), 'reference.png')
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof Error && err.name === 'AbortError')
      throw new AiError('图像编辑超时（超过 10 分钟）', '可把质量调为 medium 后重试。')
    throw new AiError(`无法连接图像服务：${msg}`, '请检查图像 Base URL 与网络。')
  } finally {
    clearTimeout(timer)
  }

  const raw = await res.text()
  if (!res.ok) throw friendlyImageError(res.status, raw)
  let data: ArkImageResponse
  try {
    data = JSON.parse(raw) as ArkImageResponse
  } catch {
    throw new AiError(`图像接口返回无法解析：${raw.slice(0, 200)}`)
  }
  if (data.error?.message) throw new AiError(`图像接口错误：${data.error.message}`)
  const item = data.data?.[0]
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64')
  if (item?.url) return downloadImage(item.url)
  throw new AiError('图像接口未返回图片数据，请重试')
}

/**
 * 统一入口：带参考图生成/编辑。
 * - 火山引擎：单次 generations 调用，参考图 URL/base64 直传（国内直连，推荐）
 * - OpenAI：有参考图走 edits，无参考图走 generations
 */
export async function generateImage(
  settings: ImageSettings,
  prompt: string,
  refs: ImageRef[] = []
): Promise<Buffer> {
  if (isArk(settings.imageBaseUrl || '')) {
    return arkGenerate(settings, prompt, refs)
  }
  if (refs.length) return openaiEdit(settings, prompt, refs)
  return openaiGenerate(settings, prompt)
}

/** 兼容旧签名：图生图/编辑 */
export async function editImage(
  settings: ImageSettings,
  prompt: string,
  referenceImages: ImageRef[]
): Promise<Buffer> {
  return generateImage(settings, prompt, referenceImages)
}

/** 图像服务连通性测试：生成一张低成本小图 */
export async function testImageConnection(
  settings: ImageSettings
): Promise<{ ok: boolean; message: string; model?: string }> {
  try {
    const buf = await generateImage(
      settings,
      'A simple blue circle on a pure white background, minimal product photography style, no text.',
      []
    )
    return {
      ok: true,
      message: `图像服务连接成功，模型 ${settings.imageModel || 'doubao-seedream-4-0-250828'} 返回 ${Math.round(buf.length / 1024)}KB 图片`,
      model: settings.imageModel,
    }
  } catch (err) {
    if (err instanceof AiError) {
      return { ok: false, message: err.hint ? `${err.message}｜${err.hint}` : err.message }
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
