import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import Jimp from 'jimp'
import { db } from '../db'
import { AiError } from './ai'

/**
 * 图片存储（文件系统缓存 + DB BLOB 真身）统一出口。
 *
 * Render 容器每次部署会清空 /tmp，所以文件系统只当缓存，真身必须落 image_blobs；
 * 这里同时被「产品生成图」「视觉参考库」使用，key 规则：
 *   产品图：{productId}/{文件名}
 *   视觉参考图：_visual/{文件名}
 *   品牌 Logo：_brand/{文件名}
 */

export const IMAGES_DIR =
  process.env.IMAGES_DIR || path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'images')

export function ownerDir(owner: string): string {
  const dir = path.join(IMAGES_DIR, owner)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function blobKey(owner: string, file: string): string {
  return `${owner}/${path.basename(file)}`
}

/** 写入：先落盘缓存，再写 DB 真身；返回文件名 */
export function saveImageBuffer(owner: string, buf: Buffer, ext = 'png'): string {
  const file = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
  try {
    fs.writeFileSync(path.join(ownerDir(owner), file), buf)
  } catch {
    /* 缓存写失败不阻塞：DB 才是真身 */
  }
  db.prepare('INSERT INTO image_blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(
    blobKey(owner, file),
    buf
  )
  return file
}

/** 读取：缓存命中直接返回，未命中从 DB 恢复缓存 */
export function readImageBuffer(owner: string, file: string): Buffer {
  const safe = path.basename(file)
  const fp = path.join(ownerDir(owner), safe)
  if (fs.existsSync(fp)) return fs.readFileSync(fp)
  const row = db.prepare('SELECT data FROM image_blobs WHERE key = ?').get(blobKey(owner, safe)) as
    | { data: Buffer | Uint8Array | string }
    | undefined
  if (!row) throw new AiError('图片文件不存在')
  const buf = Buffer.from(row.data as Uint8Array)
  try {
    fs.writeFileSync(fp, buf)
  } catch {
    /* ignore */
  }
  return buf
}

export function deleteImageBuffer(owner: string, file: string): void {
  const safe = path.basename(file)
  try {
    fs.unlinkSync(path.join(IMAGES_DIR, owner, safe))
  } catch {
    /* 文件可能已不存在 */
  }
  db.prepare('DELETE FROM image_blobs WHERE key = ?').run(blobKey(owner, safe))
}

/** 把 URL / dataURL 读成 Buffer（参考图入库、原图直出合成都要真身字节） */
export async function fetchImageBuffer(urlOrData: string): Promise<Buffer> {
  const s = urlOrData.trim()
  const dataMatch = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(s)
  if (dataMatch) return Buffer.from(dataMatch[1], 'base64')
  if (/^https?:\/\//i.test(s)) {
    const res = await fetch(s, {
      signal: AbortSignal.timeout(60_000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: /1688\.com/i.test(s) ? 'https://www.1688.com/' : new URL(s).origin,
      },
    })
    if (!res.ok) throw new AiError(`下载图片失败 (${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new AiError('图片地址不可用（要 http(s):// 或 data:image）')
}

/** 视觉 token 大头在分辨率：发给文本/视觉模型前统一缩到 640px JPEG */
export async function smallDataUrl(buf: Buffer, max = 640, quality = 82): Promise<string> {
  try {
    const img = await Jimp.read(buf)
    img.scaleToFit(max, max)
    const out = await img.quality(quality).getBufferAsync(Jimp.MIME_JPEG)
    return `data:image/jpeg;base64,${out.toString('base64')}`
  } catch {
    return `data:image/png;base64,${buf.toString('base64')}`
  }
}

/** 取图片宽高（入视觉库时记录，前端展示用） */
export async function imageSize(buf: Buffer): Promise<{ width: number | null; height: number | null }> {
  try {
    const img = await Jimp.read(buf)
    return { width: img.bitmap.width, height: img.bitmap.height }
  } catch {
    return { width: null, height: null }
  }
}
