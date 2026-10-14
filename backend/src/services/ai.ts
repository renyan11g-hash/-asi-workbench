import { Settings } from '../types'

export class AiError extends Error {
  constructor(
    message: string,
    public readonly hint?: string
  ) {
    super(message)
    this.name = 'AiError'
  }
}

interface ChatMessageContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: 'low' | 'high' | 'auto' }
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
  error?: { message?: string }
}

function endpointCandidates(baseUrl: string): string[] {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const hasVersion = /\/(v\d+)$/.test(base)
  if (hasVersion) return [`${base}/chat/completions`]
  return [`${base}/v1/chat/completions`, `${base}/chat/completions`]
}

async function post(url: string, body: unknown, apiKey: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

function friendlyError(status: number, raw: string): AiError {
  if (status === 401 || status === 403)
    return new AiError(
      `AI 接口鉴权失败 (${status})：API Key 无效或没有权限`,
      '请到「设置」检查 API Key 是否正确、是否有余额。'
    )
  if (status === 404)
    return new AiError(
      `AI 接口地址不可用 (404)`,
      '请检查 Base URL，例如 OpenAI 用 https://api.openai.com/v1 ，DeepSeek 用 https://api.deepseek.com 。'
    )
  if (status === 429)
    return new AiError('AI 接口限流 (429)：请求过于频繁或额度不足', '稍后重试，或检查账户余额。')
  if (status >= 500)
    return new AiError(`AI 服务商故障 (${status})`, '这是服务商侧的问题，稍后重试即可。')
  return new AiError(`AI 调用失败 (${status})：${raw.slice(0, 300)}`)
}

export async function callChat(
  settings: Pick<Settings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel'>,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.6,
  images?: string[]
): Promise<string> {
  const baseUrl = settings.aiBaseUrl?.trim()
  if (!baseUrl) throw new AiError('尚未配置 AI 接口地址', '请到「设置」填写 Base URL 与 API Key。')
  if (!settings.aiApiKey?.trim())
    throw new AiError('尚未配置 API Key', '请到「设置」填写 API Key 后再生成。')
  const model = settings.aiModel?.trim() || 'gpt-4o-mini'

  // 支持图片：images 为 base64 dataURL 或 https URL 列表
  const userMessage: { role: string; content: string | ChatMessageContentPart[] } = images?.length
    ? {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          ...images.map((u) => ({
            type: 'image_url' as const,
            image_url: { url: u, detail: 'auto' as const },
          })),
        ],
      }
    : { role: 'user', content: userPrompt }

  const body = {
    model,
    temperature,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      userMessage,
    ],
  }

  const candidates = endpointCandidates(baseUrl)
  let lastErr: AiError | null = null

  for (const url of candidates) {
    let res: Response
    try {
      res = await post(url, body, settings.aiApiKey.trim())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastErr =
        err instanceof Error && err.name === 'AbortError'
          ? new AiError('AI 请求超时（超过 3 分钟）', '可尝试换用更快的模型后重试。')
          : new AiError(`无法连接 AI 服务：${msg}`, '请检查 Base URL 与网络是否可访问。')
      continue
    }

    const raw = await res.text()
    if (!res.ok) {
      lastErr = friendlyError(res.status, raw)
      // 404 时换另一个候选地址
      if (res.status === 404 && candidates.length > 1) continue
      throw lastErr
    }

    let data: ChatResponse
    try {
      data = JSON.parse(raw) as ChatResponse
    } catch {
      throw new AiError(`AI 返回内容无法解析：${raw.slice(0, 200)}`)
    }
    if (data.error?.message) throw new AiError(`AI 返回错误：${data.error.message}`)
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new AiError('AI 返回内容为空，请重试')
    return content
  }

  throw lastErr ?? new AiError('AI 调用失败')
}

/** 从模型输出中稳健地提取 JSON 对象 */
export function extractJson<T>(text: string): T {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  try {
    return JSON.parse(cleaned) as T
  } catch {
    // 截取第一个 { 到最后一个 }
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T
      } catch {
        /* fallthrough */
      }
    }
    throw new AiError('AI 返回格式不是合法 JSON，请重试')
  }
}

export async function callChatJson<T>(
  settings: Pick<Settings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel'>,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.6,
  images?: string[]
): Promise<T> {
  const text = await callChat(settings, systemPrompt, userPrompt, temperature, images)
  return extractJson<T>(text)
}

export async function testConnection(
  settings: Pick<Settings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel'>
): Promise<{ ok: boolean; message: string; model?: string }> {
  try {
    const reply = await callChat(
      settings,
      'You are a connectivity probe. Reply with exactly: OK',
      'ping',
      0
    )
    return { ok: true, message: `连接成功，模型回复：${reply.trim().slice(0, 40)}`, model: settings.aiModel }
  } catch (err) {
    if (err instanceof AiError) {
      return { ok: false, message: err.hint ? `${err.message}｜${err.hint}` : err.message }
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
