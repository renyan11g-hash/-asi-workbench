import { Settings } from '../types'
import { logAiCall } from './ai-log'
import { inlineImage } from './image-inline'

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
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

/**
 * 调用参数（可选，全部向后兼容）：
 *  - model    覆盖模型：不同任务用不同模型，不需要改调用方的参数顺序
 *  - task     台账里的任务名（spec-extract / listing / listing-qc …）
 *  - productId 关联的产品，便于按产品追成本
 */
export interface ChatCallOptions {
  model?: string
  task?: string
  productId?: string | null
}

/** 一次调用的完整结果（带耗时/token，台账与界面都用它） */
export interface ChatResult {
  text: string
  model: string
  durationMs: number
  promptTokens: number | null
  completionTokens: number | null
}

/** 模型分工：任务 → 模型。留空就回落到通用模型，行为与改造前完全一致。 */
export function modelFor(
  settings: Pick<Settings, 'aiModel' | 'aiModelExtract' | 'aiModelQc'>,
  task?: string
): string {
  const base = settings.aiModel?.trim() || 'gpt-4o-mini'
  if (task === 'spec-extract' && settings.aiModelExtract?.trim()) return settings.aiModelExtract.trim()
  if (task === 'listing-qc' && settings.aiModelQc?.trim()) return settings.aiModelQc.trim()
  return base
}

function endpointCandidates(baseUrl: string): string[] {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const hasVersion = /\/(v\d+)$/.test(base)
  if (hasVersion) return [`${base}/chat/completions`]
  return [`${base}/v1/chat/completions`, `${base}/chat/completions`]
}

/** AI 请求超时（ms）：评估/Listing 生成耗时长，默认 10 分钟，可用 AI_TIMEOUT_MS 覆盖 */
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 600_000

async function post(url: string, body: unknown, apiKey: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)
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

/**
 * 真正干活的一次模型调用：返回文本 + 实际模型 + 耗时 + token，
 * 并把这一笔记进 ai_call_logs（成功失败都记，失败带错误原因）。
 */
export async function callChatResult(
  settings: Pick<Settings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel' | 'aiModelExtract' | 'aiModelQc'>,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.6,
  images?: string[],
  opts?: ChatCallOptions
): Promise<ChatResult> {
  const baseUrl = settings.aiBaseUrl?.trim()
  if (!baseUrl) throw new AiError('尚未配置 AI 接口地址', '请到「设置」填写 Base URL 与 API Key。')
  if (!settings.aiApiKey?.trim())
    throw new AiError('尚未配置 API Key', '请到「设置」填写 API Key 后再生成。')
  const model = opts?.model?.trim() || modelFor(settings, opts?.task)
  const startedAt = Date.now()

  // 支持图片：images 为 base64 dataURL 或 https URL 列表
  // 发请求前把图片读成 data URL：
  // - 1688 图有防盗链，模型服务商从机房直接抓大概率被拒（结果就是「模型没见过产品」）
  // - 我们自己存的 /api/product-images/... 是站内相对地址，模型更抓不到
  // 读不到时保留原地址，让服务商再试一次（不因为本地网络问题直接丢图）。
  const modelImages = images?.length
    ? (
        await Promise.all(
          images.map(async (u) => {
            try {
              return (await inlineImage(u)) ?? u
            } catch {
              return u
            }
          })
        )
      ).filter((u): u is string => Boolean(u))
    : images
  const userMessage: { role: string; content: string | ChatMessageContentPart[] } = modelImages?.length
    ? {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          ...modelImages.map((u) => ({
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

  const fail = (err: AiError): never => {
    logAiCall({
      task: opts?.task ?? '',
      productId: opts?.productId,
      model,
      baseUrl,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: err.message,
    })
    throw err
  }

  for (const url of candidates) {
    let res: Response
    try {
      res = await post(url, body, settings.aiApiKey.trim())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastErr =
        err instanceof Error && err.name === 'AbortError'
          ? new AiError('AI 请求超时（超过 10 分钟）', '可尝试换用更快的模型后重试。')
          : new AiError(`无法连接 AI 服务：${msg}`, '请检查 Base URL 与网络是否可访问。')
      continue
    }

    const raw = await res.text()
    if (!res.ok) {
      lastErr = friendlyError(res.status, raw)
      // 404 时换另一个候选地址
      if (res.status === 404 && candidates.length > 1) continue
      return fail(lastErr)
    }

    let data: ChatResponse
    try {
      data = JSON.parse(raw) as ChatResponse
    } catch {
      return fail(new AiError(`AI 返回内容无法解析：${raw.slice(0, 200)}`))
    }
    if (data.error?.message) return fail(new AiError(`AI 返回错误：${data.error.message}`))
    const content = data.choices?.[0]?.message?.content
    if (!content) return fail(new AiError('AI 返回内容为空，请重试'))

    const durationMs = Date.now() - startedAt
    const promptTokens =
      typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : null
    const completionTokens =
      typeof data.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : null
    logAiCall({
      task: opts?.task ?? '',
      productId: opts?.productId,
      model,
      baseUrl,
      durationMs,
      promptTokens,
      completionTokens,
      ok: true,
    })
    return { text: content, model, durationMs, promptTokens, completionTokens }
  }

  return fail(lastErr ?? new AiError('AI 调用失败'))
}

export async function callChat(
  settings: Pick<Settings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel' | 'aiModelExtract' | 'aiModelQc'>,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.6,
  images?: string[],
  opts?: ChatCallOptions
): Promise<string> {
  const result = await callChatResult(settings, systemPrompt, userPrompt, temperature, images, opts)
  return result.text
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
  settings: Pick<Settings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel' | 'aiModelExtract' | 'aiModelQc'>,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.6,
  images?: string[],
  opts?: ChatCallOptions
): Promise<T> {
  const text = await callChat(settings, systemPrompt, userPrompt, temperature, images, opts)
  return extractJson<T>(text)
}

export async function callChatJsonDetailed<T>(
  settings: Pick<Settings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel' | 'aiModelExtract' | 'aiModelQc'>,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.6,
  images?: string[],
  opts?: ChatCallOptions
): Promise<{ data: T; model: string; durationMs: number }> {
  const result = await callChatResult(settings, systemPrompt, userPrompt, temperature, images, opts)
  return { data: extractJson<T>(result.text), model: result.model, durationMs: result.durationMs }
}

export async function testConnection(
  settings: Pick<Settings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel'>
): Promise<{ ok: boolean; message: string; model?: string }> {
  try {
    const reply = await callChat(
      settings,
      'You are a connectivity probe. Reply with exactly: OK',
      'ping',
      0,
      undefined,
      { task: 'settings-test' }
    )
    return { ok: true, message: `连接成功，模型回复：${reply.trim().slice(0, 40)}`, model: settings.aiModel }
  } catch (err) {
    if (err instanceof AiError) {
      return { ok: false, message: err.hint ? `${err.message}｜${err.hint}` : err.message }
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
