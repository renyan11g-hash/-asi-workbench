import Jimp from 'jimp'
import { AiError } from './ai'

/**
 * 尺寸图程序化标注：
 * AI 只负责生成"干净的产品图"（无文字无标线），尺寸线与 inch 数字由本模块用
 * Jimp 原生绘图 API 直接叠加，保证数字 100% 精确（AI 直接画数字经常出错）。
 *
 * 注：早期版本用 SVG overlay + Jimp.read(Buffer.from(svg))，但 Jimp 不支持
 * SVG buffer 输入（报 "Could not find MIME for Buffer <null>"），故改为纯
 * Jimp 画线/箭头/文字（loadFont + print + rotate），不再依赖 SVG。
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

const LINE_W = 6
const ARROW_S = 18
const INK = { r: 0x00, g: 0x00, b: 0x00, a: 255 } // 纯黑，保证清晰可见

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

/* ---------- Jimp 原生绘图工具 ---------- */

let fontPromise: Promise<any> | null = null
function getFont(): Promise<any> {
  if (!fontPromise) fontPromise = Jimp.loadFont(Jimp.FONT_SANS_64_BLACK)
  return fontPromise
}

/** 画一条加粗线段（Bresenham + 方形笔刷），坐标自动裁剪到画布内 */
function drawLine(img: Jimp, x1: number, y1: number, x2: number, y2: number, thickness = LINE_W): void {
  const { width, height, data } = img.bitmap
  const half = Math.floor(thickness / 2)
  const dx = Math.abs(x2 - x1)
  const dy = Math.abs(y2 - y1)
  const sx = x1 < x2 ? 1 : -1
  const sy = y1 < y2 ? 1 : -1
  let err = dx - dy
  let x = x1
  let y = y1
  for (;;) {
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        const px = x + ox
        const py = y + oy
        if (px < 0 || py < 0 || px >= width || py >= height) continue
        const i = (py * width + px) * 4
        data[i] = INK.r
        data[i + 1] = INK.g
        data[i + 2] = INK.b
        data[i + 3] = INK.a
      }
    }
    if (x === x2 && y === y2) break
    const e2 = 2 * err
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 < dx) { err += dx; y += sy }
  }
}

/** 在 (x,y) 画方向箭头（两条 45° 短线组成 V 形，尖端指向 (x,y)） */
function drawArrow(img: Jimp, x: number, y: number, dir: 'l' | 'r' | 'u' | 'd'): void {
  const s = ARROW_S
  if (dir === 'l') {
    drawLine(img, x + s, y - s, x, y)
    drawLine(img, x + s, y + s, x, y)
  } else if (dir === 'r') {
    drawLine(img, x - s, y - s, x, y)
    drawLine(img, x - s, y + s, x, y)
  } else if (dir === 'u') {
    drawLine(img, x - s, y + s, x, y)
    drawLine(img, x + s, y + s, x, y)
  } else {
    drawLine(img, x - s, y - s, x, y)
    drawLine(img, x + s, y - s, x, y)
  }
}

/** 把文字渲染到透明小图上并重新着色为 INK，返回图与尺寸 */
async function renderText(text: string): Promise<{ img: Jimp; w: number; h: number }> {
  const font = await getFont()
  const tw = Math.ceil(Jimp.measureText(font, text)) + 8
  const th = Math.ceil(Jimp.measureTextHeight(font, text, tw)) + 8
  const t = new Jimp(tw, th, 0x00000000)
  t.print(font, 4, 4, text)
  const d = t.bitmap.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) {
      d[i] = INK.r
      d[i + 1] = INK.g
      d[i + 2] = INK.b
      d[i + 3] = INK.a
    }
  }
  return { img: t, w: tw, h: th }
}

/** 画尺寸线 + 文字，直接叠加到原图（纯 Jimp，无 SVG） */
export async function overlayDimensions(input: Buffer, spec: OverlaySpec): Promise<Buffer> {
  const img = await Jimp.read(input).catch(() => {
    throw new AiError('尺寸图叠加失败：无法解析生成的图片')
  })
  const { width, height } = img.bitmap
  const box = detectBoundingBox(img)

  // 标注方向与产品在图中的朝向对齐：AI 摆放朝向不可控，若图片里竖放但数值"宽>高"
  // （或横放但"高>宽"）则互换，保证底部线标视觉横向尺寸、右侧线标视觉纵向尺寸
  const boxW = box.right - box.left
  const boxH = box.bottom - box.top
  let widthIn = spec.widthIn
  let heightIn = spec.heightIn
  if (
    (boxH > boxW * 1.15 && widthIn > heightIn * 1.15) ||
    (boxW > boxH * 1.15 && heightIn > widthIn * 1.15)
  ) {
    ;[widthIn, heightIn] = [heightIn, widthIn]
  }

  // 尺寸线与产品保持明显间距（不与产品重叠），且不能贴出画布边缘：
  // 先按产品包围盒向外扩 pad 作为线位置；若空间不足，再把线推回画布内并保证仍在线外留出箭头/文字空间
  const pad = Math.round(Math.min(width, height) * 0.1) // 尺寸线与产品的最小间距
  const margin = Math.round(Math.min(width, height) * 0.14) // 画布边缘留白（含箭头+文字）
  const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1)

  // 底部宽度线：优先放在产品下方 pad 处；画布下方空间不足时收紧 pad（但至少 12px，仍不与产品重叠）
  const maxPadW = height - margin - LINE_W - box.bottom
  const padW = Math.max(12, Math.min(pad, maxPadW))
  const yW = box.bottom + padW
  drawLine(img, box.left, yW, box.right, yW)
  drawArrow(img, box.left, yW, 'l')
  drawArrow(img, box.right, yW, 'r')
  {
    const label = `${fmt(widthIn)} in`
    const t = await renderText(label)
    let tx = Math.round((box.left + box.right) / 2 - t.w / 2)
    let ty = yW + 8
    if (ty + t.h > height) ty = yW - 8 - t.h // 下方放不下就放到线上方
    tx = Math.max(0, Math.min(tx, Math.max(0, width - t.w)))
    ty = Math.max(0, ty)
    img.composite(t.img, tx, ty)
  }

  // 右侧高度线（文字旋转 90°，自上而下阅读）：同底部线逻辑，保证不与产品重叠且不出画布
  const maxPadH = width - margin - LINE_W - box.right
  const padH = Math.max(12, Math.min(pad, maxPadH))
  const xH = box.right + padH
  drawLine(img, xH, box.top, xH, box.bottom)
  drawArrow(img, xH, box.top, 'u')
  drawArrow(img, xH, box.bottom, 'd')
  {
    const label = `${fmt(heightIn)} in`
    const t = await renderText(label)
    t.img.rotate(90, true) // 顺时针 90°：文字自上而下
    const rw = t.img.bitmap.width
    const rh = t.img.bitmap.height
    let tx = xH + 8
    if (tx + rw > width) tx = xH - 8 - rw // 右侧放不下就放到线左侧
    const ty = Math.round((box.top + box.bottom) / 2 - rh / 2)
    img.composite(t.img, Math.max(0, tx), Math.max(0, ty))
  }

  // 左上深度线（可选）：斜 45° 表示深度
  if (spec.depthIn && spec.depthIn > 0) {
    const d = Math.round(Math.min(width, height) * 0.12)
    const x1 = box.left
    const y1 = box.top
    const x2 = x1 - d
    const y2 = y1 - d
    if (x2 > margin && y2 > margin) {
      drawLine(img, x1, y1, x2, y2)
      drawArrow(img, x2, y2, 'u')
      const label = `${fmt(spec.depthIn)} in`
      const t = await renderText(label)
      const tx = Math.max(0, x2 - 8 - t.w)
      const ty = Math.max(0, y2 - 8 - t.h)
      img.composite(t.img, tx, ty)
    }
  }

  return img.getBufferAsync(Jimp.MIME_PNG)
}
