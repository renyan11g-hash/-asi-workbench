/**
 * 带 jina 兜底的网页抓取（海外探针共用）。
 *
 * 为什么需要：supplier.espwebsite.com 前面是 Cloudflare，Render 的机房 IP 直连会被挡成 403，
 * 而本机住宅 IP 是 200。所以统一"先直连，被挡就退 r.jina.ai"，
 * 并且 jina 必须带 x-return-format: html —— 它默认返回 markdown，会把结构全打散。
 *
 * 设计取舍：只做一层兜底，不做代理池/重试风暴。抓不到就让调用方降级，
 * 评估流程绝不能因为一个外部站点抽风而中断。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const JINA_PREFIX = 'https://r.jina.ai/'

type SimpleResponse = { ok: boolean; status?: number; text(): Promise<string> }
type SimpleFetch = (
  url: string,
  init?: { signal?: unknown; headers?: Record<string, string> }
) => Promise<SimpleResponse>

const nativeFetch = (globalThis as unknown as { fetch?: SimpleFetch }).fetch

export interface FetchOutcome {
  ok: boolean
  text?: string
  status?: number
  error?: string
  /** 这一页是怎么拿到的 */
  via: 'direct' | 'jina'
}

export interface FetchOptions {
  timeoutMs: number
  /** jina 要自己去抓一次，默认至少给 15 秒 */
  jinaTimeoutMs?: number
  /** 额外请求头（直连时附加） */
  headers?: Record<string, string>
  /** 判断拿到的内容是不是"真页面"（挡掉 Cloudflare 挑战页 / 登录墙） */
  looksOk?: (text: string) => boolean
}

async function fetchOnce(
  url: string,
  timeoutMs: number,
  via: 'direct' | 'jina',
  headers: Record<string, string>
): Promise<FetchOutcome> {
  if (!nativeFetch) return { ok: false, error: '运行时没有 fetch（Node 版本过低）', via }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await nativeFetch(url, { signal: ctrl.signal, headers })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, via }
    const text = await res.text()
    return { ok: true, status: res.status, text, via }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    return { ok: false, error: /abort/i.test(msg) ? `超时（${timeoutMs}ms）` : msg, via }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchWithJinaFallback(url: string, opts: FetchOptions): Promise<FetchOutcome> {
  if (!nativeFetch) return { ok: false, error: '运行时没有 fetch（Node 版本过低）', via: 'direct' }
  const looksOk = opts.looksOk ?? (() => true)

  const direct = await fetchOnce(
    url,
    opts.timeoutMs,
    'direct',
    {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(opts.headers ?? {}),
    }
  )
  if (direct.ok && direct.text && looksOk(direct.text)) return direct

  const jina = await fetchOnce(
    JINA_PREFIX + url,
    Math.max(opts.jinaTimeoutMs ?? 0, opts.timeoutMs, 15000),
    'jina',
    { 'User-Agent': UA, Accept: 'text/html', 'x-return-format': 'html' }
  )
  if (jina.ok && jina.text && looksOk(jina.text)) return jina

  // 都不行：直连的状态码更能说明问题（403=被挡，404=页面不存在），优先报它
  if (!direct.ok) return direct
  return jina
}
