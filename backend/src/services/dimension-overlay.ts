import Jimp from 'jimp'
import { AiError } from './ai'
import { detectProductBox, inflateBox, normalizeWhiteBackground } from './image-post'

/**
 * 尺寸图程序化标注：
 * AI 只负责生成"干净的白底产品图"（无文字无标线），尺寸线与 inch 数字由本模块用
 * Jimp 原生绘图 API 直接叠加，保证数字 100% 精确（AI 直接画数字经常出错）。
 *
 * 关键设计（2026-11 重写）：
 *  1. **先扩画布**：无论 AI 出图留白多少，一律往四周扩出足够的白边，
 *     尺寸线和数字只画在这圈新增的空白里 —— 物理上不可能压到产品上。
 *     旧实现是在原图上找空隙画，空隙不够时 pad 被压缩到 12px，仍会贴住甚至压住产品。
 *  2. 标注前先把外圈刷成纯白，保证成品是 ASI 目录要求的纯白底。
 *  3. 数字先渲染量尺寸，再决定留白宽度 —— 保证标签一定放得下、不被裁掉。
 *  4. 包围盒外扩 2% 再画线，避免箭头尖端顶到产品边缘。
 */

interface OverlaySpec {
  widthIn: number
  heightIn: number
  depthIn: number | null
}

const LINE_W = 6
const ARROW_S = 18
const INK = { r: 0x00, g: 0x00, b: 0x00, a: 255 } // 纯黑，保证清晰可见
const WHITE_BG = 0xffffffff

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

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))

/** 画尺寸线 + 文字：先扩白边再画，线与数字永远在产品框外 */
export async function overlayDimensions(input: Buffer, spec: OverlaySpec): Promise<Buffer> {
  const img: Jimp = await Jimp.read(input).catch(() => {
    throw new AiError('尺寸图叠加失败：无法解析生成的图片')
  })

  // 1) 先量包围盒（必须在刷白之前：刷白会把"浅色产品 vs 浅灰底"的差异抹平）
  const raw = detectProductBox(img, 14)
  const W = img.bitmap.width
  const H = img.bitmap.height
  const minDim = Math.min(W, H)
  // 外扩 2%：箭头尖端不顶到产品
  const box = inflateBox(raw, Math.round(minDim * 0.02), W, H)

  // 2) 统一成纯白背景（标注区必须是干净白底）
  normalizeWhiteBackground(img, 0.14)

  // 3) 标注方向与图片里的实际朝向对齐：AI 摆放朝向不可控
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
  const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1)

  // 3) 先把文字渲染出来量尺寸，再决定画布留白宽度（保证标签放得下）
  const wText = await renderText(`${fmt(widthIn)} in`)
  const hText = await renderText(`${fmt(heightIn)} in`)
  hText.img.rotate(90, true) // 顺时针 90°：文字自上而下
  const hw = hText.img.bitmap.width
  const hh = hText.img.bitmap.height

  const gap = Math.max(10, Math.round(minDim * 0.035)) // 线到产品的间距
  const basePad = Math.max(8, Math.round(minDim * 0.03)) // 画布最小外边距
  const depthPad = spec.depthIn && spec.depthIn > 0 ? Math.round(minDim * 0.10) : 0 // 深度斜线要的空间
  const padLeft = basePad + depthPad
  const padTop = basePad + depthPad
  const padRight = gap + 8 + hw + basePad
  const padBottom = gap + 8 + wText.h + basePad

  const canvas = new Jimp(W + padLeft + padRight, H + padTop + padBottom, WHITE_BG)
  canvas.composite(img, padLeft, padTop)

  const left = box.left + padLeft
  const right = box.right + padLeft
  const top = box.top + padTop
  const bottom = box.bottom + padTop

  // 4) 底部：宽度线（画在产品下方的白边里）
  const yW = bottom + gap
  drawLine(canvas, left, yW, right, yW)
  drawArrow(canvas, left, yW, 'l')
  drawArrow(canvas, right, yW, 'r')
  {
    const tx = clamp(Math.round((left + right) / 2 - wText.w / 2), 2, canvas.bitmap.width - wText.w - 2)
    const ty = clamp(yW + 8, 2, canvas.bitmap.height - wText.h - 2)
    canvas.composite(wText.img, tx, ty)
  }

  // 5) 右侧：高度线（画在产品右侧的白边里，文字旋转 90°）
  const xH = right + gap
  drawLine(canvas, xH, top, xH, bottom)
  drawArrow(canvas, xH, top, 'u')
  drawArrow(canvas, xH, bottom, 'd')
  {
    const tx = clamp(xH + 8, 2, canvas.bitmap.width - hw - 2)
    const ty = clamp(Math.round((top + bottom) / 2 - hh / 2), 2, canvas.bitmap.height - hh - 2)
    canvas.composite(hText.img, tx, ty)
  }

  // 6) 左上：深度线（斜 45°，只在留白够时画）
  if (spec.depthIn && spec.depthIn > 0) {
    const d = Math.round(minDim * 0.09)
    const x1 = left
    const y1 = top
    const x2 = x1 - d
    const y2 = y1 - d
    if (x2 > 6 && y2 > 6) {
      drawLine(canvas, x1, y1, x2, y2)
      drawArrow(canvas, x2, y2, 'u')
      const t = await renderText(`${fmt(spec.depthIn)} in`)
      const tx = clamp(x2 - t.w - 6, 2, canvas.bitmap.width - t.w - 2)
      const ty = clamp(y2 - t.h - 6, 2, canvas.bitmap.height - t.h - 2)
      canvas.composite(t.img, tx, ty)
    }
  }

  return canvas.getBufferAsync(Jimp.MIME_PNG)
}
