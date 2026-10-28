import Jimp from 'jimp'
import { AiError } from './ai'

/**
 * 尺寸图程序化标注：
 * AI 只负责生成"干净的产品图"（无文字无标线），尺寸线与 inch 数字由本模块用
 * Jimp + SVG 叠加，保证数字 100% 精确（AI 直接画数字经常出错）。
 *
 * 标注方式：产品包围盒（自动检测非白像素范围）四周画箭头尺寸线：
 *   - 底部：宽度 W in
 *   - 右侧：高度 H in
 *   - 左上：深度 D in（可选，仅当提供 depthIn）
 */

interface OverlaySpec {
  widthIn: number
  heightIn: number
  depthIn: number | null
}

const LINE_W = 4
const FONT_SIZE = 44

/** 检测产品包围盒：扫描非白色（且非透明）像素 */
function detectBoundingBox(img: Jimp): { left: number; top: number; right: number; bottom: number } {
  const { width, height } = img.bitmap
  const data = img.bitmap.data
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  const threshold = 245 // 接近白色视为背景
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const a = data[i + 3]
      if (a < 32) continue // 透明
      if (r > threshold && g > threshold && b > threshold) continue // 白背景
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < 0) {
    // 全白图：退化为中央 60% 区域
    return {
      left: Math.round(width * 0.2),
      top: Math.round(height * 0.2),
      right: Math.round(width * 0.8),
      bottom: Math.round(height * 0.8),
    }
  }
  return { left, top, right, bottom }
}

/** 用 SVG 画尺寸线 + 文字，再 composite 到原图 */
export async function overlayDimensions(input: Buffer, spec: OverlaySpec): Promise<Buffer> {
  const img = await Jimp.read(input).catch(() => {
    throw new AiError('尺寸图叠加失败：无法解析生成的图片')
  })
  const { width, height } = img.bitmap
  const box = detectBoundingBox(img)

  const pad = Math.round(Math.min(width, height) * 0.08) // 尺寸线与产品的间距
  const margin = Math.round(Math.min(width, height) * 0.12) // 画布边缘留白
  const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1)

  const lines: string[] = []
  const arrow = (x: number, y: number, dir: 'l' | 'r' | 'u' | 'd') => {
    const s = 14
    if (dir === 'l') return `<path d="M${x + s},${y - s} L${x},${y} L${x + s},${y + s}" stroke="#1e293b" stroke-width="${LINE_W}" fill="none"/>`
    if (dir === 'r') return `<path d="M${x - s},${y - s} L${x},${y} L${x - s},${y + s}" stroke="#1e293b" stroke-width="${LINE_W}" fill="none"/>`
    if (dir === 'u') return `<path d="M${x - s},${y + s} L${x},${y} L${x + s},${y + s}" stroke="#1e293b" stroke-width="${LINE_W}" fill="none"/>`
    return `<path d="M${x - s},${y - s} L${x},${y} L${x + s},${y - s}" stroke="#1e293b" stroke-width="${LINE_W}" fill="none"/>`
  }

  // 底部宽度线
  const yW = Math.min(height - margin, box.bottom + pad)
  lines.push(
    `<line x1="${box.left}" y1="${yW}" x2="${box.right}" y2="${yW}" stroke="#1e293b" stroke-width="${LINE_W}"/>`,
    arrow(box.left, yW, 'l'),
    arrow(box.right, yW, 'r'),
    `<text x="${(box.left + box.right) / 2}" y="${yW + FONT_SIZE + 8}" font-family="Arial, Helvetica, sans-serif" font-size="${FONT_SIZE}" font-weight="bold" fill="#1e293b" text-anchor="middle">${fmt(spec.widthIn)} in</text>`
  )

  // 右侧高度线
  const xH = Math.min(width - margin, box.right + pad)
  lines.push(
    `<line x1="${xH}" y1="${box.top}" x2="${xH}" y2="${box.bottom}" stroke="#1e293b" stroke-width="${LINE_W}"/>`,
    arrow(xH, box.top, 'u'),
    arrow(xH, box.bottom, 'd'),
    `<text x="${xH + FONT_SIZE * 0.6}" y="${(box.top + box.bottom) / 2}" font-family="Arial, Helvetica, sans-serif" font-size="${FONT_SIZE}" font-weight="bold" fill="#1e293b" text-anchor="start" transform="rotate(90 ${xH + FONT_SIZE * 0.6} ${(box.top + box.bottom) / 2})">${fmt(spec.heightIn)} in</text>`
  )

  // 左上深度线（可选）：斜 45° 表示深度
  if (spec.depthIn && spec.depthIn > 0) {
    const d = Math.round(Math.min(width, height) * 0.12)
    const x1 = box.left
    const y1 = box.top
    const x2 = x1 - d
    const y2 = y1 - d
    if (x2 > margin && y2 > margin) {
      lines.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1e293b" stroke-width="${LINE_W}"/>`,
        arrow(x2, y2, 'u'),
        `<text x="${x2 - 8}" y="${y2 - 8}" font-family="Arial, Helvetica, sans-serif" font-size="${FONT_SIZE}" font-weight="bold" fill="#1e293b" text-anchor="end">${fmt(spec.depthIn)} in</text>`
      )
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${lines.join('')}</svg>`
  const overlay = await Jimp.read(Buffer.from(svg))
  img.composite(overlay, 0, 0)

  return img.getBufferAsync(Jimp.MIME_PNG)
}
