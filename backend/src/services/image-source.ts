/**
 * 外部图片（1688 / alicdn / 任意 http 图）抓取与规整。
 *
 * 为什么要有这一层：
 * 1. 1688 的图有防盗链。浏览器从我们的域名（asi-workbench.onrender.com）直接引用会带
 *    我们的 Referer，被 alicdn 判成盗链 → 403/错误页 → 页面上就是「破损图片」。
 *    服务器端带上 1688 的 Referer 重新下载是能拿到真正图片的。
 * 2. 复制出来的链接经常过期、被删、或者只是缩略图地址；链接一失效，页面破损，
 *    AI 出图时拿不到实物参考，就会「凭空捏造」一个产品。
 * 所以：能下载的一律下载下来存进我们自己的存储/数据库，页面上、出图时都只用本地图。
 *
 * 这里只负责「网络 + 图片规整」，不碰数据库（避免和 product-images 循环依赖）。
 */

import Jimp from 'jimp'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 1688 图片要求带 Referer；先试详情页，再试空 Referer（部分第三方图床不允许带 Referer） */
const REFERERS = ['https://detail.1688.com/', '']

const MAX_BYTES = 12 * 1024 * 1024

export interface RemoteImage {
  buffer: Buffer
  contentType: string
  /** 规整后的扩展名：jpg / png / webp / gif */
  ext: string
  width?: number
  height?: number
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test((url ?? '').trim())
}

export function isManagedImage(url: string): boolean {
  return /^\/api\/product-images\//.test((url ?? '').trim())
}

/** 清理从网页/聊天里复制出来的地址：引号、&amp;、协议相对、http→https */
export function normalizeRemoteUrl(raw: string): string {
  let u = (raw ?? '').trim()
  u = u.replace(/&amp;/g, '&').replace(/^[<"'\s]+|[>"'\s]+$/g, '')
  if (u.startsWith('//')) u = `https:${u}`
  if (/^http:\/\//i.test(u)) u = u.replace(/^http:\/\//i, 'https://')
  return u
}

/** 按文件头判断真实图片格式（1688 的 content-type 有时是 text/html 的假图） */
export function sniffExt(buf: Buffer): string {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'png'
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP')
    return 'webp'
  if (buf.length > 3 && buf.subarray(0, 3).toString() === 'GIF') return 'gif'
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
  return 'jpg'
}

export function contentTypeOf(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    default:
      return 'image/jpeg'
  }
}

async function downloadOnce(url: string, referer: string, timeoutMs: number): Promise<RemoteImage> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    if (referer) headers.Referer = referer
    const r = await fetch(url, { headers, redirect: 'follow', signal: controller.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const type = (r.headers.get('content-type') ?? '').toLowerCase()
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) throw new Error('返回空文件')
    if (buf.length > MAX_BYTES) throw new Error(`图片太大（${Math.round(buf.length / 1024 / 1024)}MB）`)
    // content-type 不是图片、且文件头也不像图片 → 多半是防盗链的 HTML 错误页
    const ext = sniffExt(buf)
    const looksImage = type.startsWith('image/') || ext !== 'jpg' || (buf[0] === 0xff && buf[1] === 0xd8)
    if (!looksImage) throw new Error(`不是图片（${type || '未知类型'}）`)
    if (buf.length < 512) throw new Error('图片文件异常小，可能是错误页')
    return { buffer: buf, contentType: contentTypeOf(ext), ext }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下载一张外部图片。会依次换 Referer 重试（防盗链的图带 1688 Referer 才给）。
 * 失败抛出可读原因，方便界面提示「链接已失效」。
 */
export async function fetchRemoteImage(
  rawUrl: string,
  opts?: { timeoutMs?: number }
): Promise<RemoteImage> {
  const url = normalizeRemoteUrl(rawUrl)
  if (!/^https?:\/\//i.test(url)) throw new Error('不是 http(s) 图片地址')
  const timeoutMs = opts?.timeoutMs ?? 8000
  let last = '下载失败'
  for (const referer of REFERERS) {
    try {
      return await downloadOnce(url, referer, timeoutMs)
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
      // 4xx/5xx 换 Referer 也救不回来，直接返回原因（省时间）
      if (/^HTTP (4\d\d|5\d\d)$/.test(last) && last !== 'HTTP 403') break
    }
  }
  throw new Error(last)
}

/** 同上，但失败返回 null（批量场景不想抛） */
export async function tryFetchRemoteImage(
  url: string,
  opts?: { timeoutMs?: number }
): Promise<RemoteImage | null> {
  try {
    return await fetchRemoteImage(url, opts)
  } catch {
    return null
  }
}

/** data URL → Buffer（带格式识别）；不是 base64 图片返回 null */
export function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; ext: string } | null {
  const m = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec((dataUrl ?? '').trim())
  if (!m) return null
  try {
    const buffer = Buffer.from(m[2], 'base64')
    if (!buffer.length) return null
    const declared = m[1].toLowerCase().replace('jpeg', 'jpg')
    return { buffer, ext: declared === 'jpg' || declared === 'png' || declared === 'webp' ? declared : sniffExt(buffer) }
  } catch {
    return null
  }
}

/**
 * 把任意图片规整成「适合展示 + 适合给模型看」的 JPEG：
 * - 最长边压到 max（1200 足够，模型也会自己缩放，省 token 省带宽）
 * - 透明 PNG 铺白底（否则压 JPEG 会变黑）
 * - Jimp 解不了的格式（如 webp）原样返回
 */
export async function normalizeImage(
  buffer: Buffer,
  opts?: { max?: number; quality?: number }
): Promise<{ buffer: Buffer; ext: string }> {
  const max = opts?.max ?? 1600
  const quality = opts?.quality ?? 88
  try {
    const img = await Jimp.read(buffer)
    const canvas = new Jimp(img.getWidth(), img.getHeight(), 0xffffffff)
    canvas.composite(img, 0, 0)
    if (canvas.getWidth() > max || canvas.getHeight() > max) canvas.scaleToFit(max, max)
    const out = await canvas.quality(quality).getBufferAsync(Jimp.MIME_JPEG)
    return { buffer: out, ext: 'jpg' }
  } catch {
    return { buffer, ext: sniffExt(buffer) }
  }
}

/** 任意图片 → data URL（给视觉模型用） */
export async function toJpegDataUrl(buffer: Buffer, max = 1200, quality = 84): Promise<string> {
  const norm = await normalizeImage(buffer, { max, quality })
  const mime = norm.ext === 'jpg' ? 'image/jpeg' : contentTypeOf(norm.ext)
  return `data:${mime};base64,${norm.buffer.toString('base64')}`
}
