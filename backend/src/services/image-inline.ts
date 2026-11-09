/**
 * 把外部图片地址变成可以直接显示的数据（data URL）。
 *
 * 为什么需要：1688 的图片（cbu01.alicdn.com）有防盗链，浏览器从我们域名直接引用
 * 会被拒/返回错误页，页面上就是「破损图片」——但服务器端带 Referer 去下载是能拿到的。
 * 所以写进批量条目/资料库之前，统一抓回来压成 720px 的 JPEG data URL，
 * 之后展示、出图参考、入库都不再依赖外链。
 */

import Jimp from 'jimp'
import { db } from '../db'
import { tryFetchRemoteImage } from './image-source'

const MAX_BYTES = 8 * 1024 * 1024
const TARGET = 720
const QUALITY = 72

/** 同一条链接只下载一次（一批里经常重复引用同一张主图） */
const cache = new Map<string, string>()

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * 站内图片地址 → 统一的 `/api/product-images/{pid}/{file}` 形式。
 * 线上会出现两种写法：页面上是相对地址 `/api/...`，而接口/记录里可能是带域名的绝对地址
 * `https://asi-workbench.onrender.com/api/...`——两种都必须认，否则会被当成外链去抓，
 * 或者更糟：被原样发给图像服务商（方舟直接 400 invalid url）。
 */
export function managedImagePath(url: string): string | null {
  const raw = (url ?? '').trim()
  if (!raw) return null
  let pathname = raw
  if (/^https?:\/\//i.test(raw)) {
    try {
      pathname = new URL(raw).pathname
    } catch {
      return null
    }
  }
  const m = /^\/api\/product-images\/([^/]+)\/([^/?#]+)/.exec(pathname)
  if (!m) return null
  return `/api/product-images/${m[1]}/${m[2]}`
}

/** 我们自己存储的图片（/api/product-images/{pid}/{file}）：从 DB 的 image_blobs 读，部署后也不丢 */
function managedImageBuffer(url: string): Buffer | null {
  const path = managedImagePath(url)
  if (!path) return null
  const m = /^\/api\/product-images\/([^/]+)\/([^/?#]+)/.exec(path)
  if (!m) return null
  try {
    const row = db.prepare('SELECT data FROM image_blobs WHERE key = ?').get(`${m[1]}/${m[2]}`) as
      | { data: Buffer | Uint8Array | string }
      | undefined
    if (!row) return null
    return Buffer.from(row.data as Uint8Array)
  } catch {
    return null
  }
}

async function download(url: string): Promise<Buffer | null> {
  const remote = await tryFetchRemoteImage(url, { timeoutMs: 12_000 })
  if (!remote || remote.buffer.length > MAX_BYTES) return null
  return remote.buffer
}

async function toDataUrl(buf: Buffer): Promise<string | null> {
  try {
    const img = await Jimp.read(buf)
    // 统一成白底：透明 PNG 压 JPEG 会变黑，而我们的出图要求本来就是纯白背景
    const canvas = new Jimp(img.getWidth(), img.getHeight(), 0xffffffff)
    canvas.composite(img, 0, 0)
    if (canvas.getWidth() > TARGET || canvas.getHeight() > TARGET) {
      canvas.scaleToFit(TARGET, TARGET)
    }
    const out = await canvas.quality(QUALITY).getBufferAsync(Jimp.MIME_JPEG)
    return `data:image/jpeg;base64,${out.toString('base64')}`
  } catch {
    return null
  }
}

/** 单张：http(s) 的下载并转成 data URL；已经是 data URL 的原样返回；站内存储从 DB 读 */
export async function inlineImage(url: string): Promise<string | null> {
  const u = (url ?? '').trim()
  if (!u) return null
  if (u.startsWith('data:image/')) return u
  const hit = cache.get(u)
  if (hit) return hit

  let buf: Buffer | null = null
  if (managedImagePath(u)) buf = managedImageBuffer(u)
  else if (isHttp(u)) buf = await download(u)
  if (!buf) return null

  const dataUrl = await toDataUrl(buf)
  if (!dataUrl) return null
  if (cache.size > 400) cache.clear()
  cache.set(u, dataUrl)
  return dataUrl
}

/**
 * 批量处理一组图片：能内联的内联，抓不到的直接丢掉（留着只会在页面上显示破损图）。
 * 返回 dropped 方便提示用户「N 张图抓不到，请手动上传」。
 */
export async function inlineImages(images: string[]): Promise<{ images: string[]; dropped: number }> {
  const out: string[] = []
  let dropped = 0
  for (const raw of images.slice(0, 8)) {
    const one = await inlineImage(raw)
    if (one) {
      if (!out.includes(one)) out.push(one)
    } else {
      dropped += 1
    }
  }
  return { images: out, dropped }
}
