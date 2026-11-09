import Jimp from 'jimp'
import { AiError } from './ai'
import { CANVAS_SIZE, detectProductBox, normalizeWhiteBackground } from './image-post'

/**
 * 尺寸图程序化标注：
 * AI 只负责生成"干净的白底产品图"（无文字无标线），尺寸线与 inch 数字由本模块用
 * Jimp 原生绘图 API 直接叠加，保证数字 100% 精确（AI 直接画数字经常出错）。
 *
 * 关键设计（2026-11 重写）：
 *  0. **画布固定 1200×1200**（ESP 上传要求方图），任何情况下成品尺寸都不变。
 *  1. 画布不能变大，那就把产品**等比缩进可用区**：按产品包围盒算缩放比，
 *     四周留出的白边正好用来画尺寸线 —— 标注线物理上不可能压到产品上。
 *     旧实现是在原图上找空隙画，空隙不够时 pad 被压缩到 12px，仍会贴住甚至压住产品。
 *  2. 标注前先把背景刷成纯白，保证成品是 ASI 目录要求的纯白底。
 *  3. 数字先渲染量尺寸，再反推可用区宽度 —— 保证标签一定放得下、不被裁掉。
 *  4. 方向（宽/高）必须在渲染数字之前用包围盒长宽比定下来，否则数字会和线标反。
 *  3. 数字先渲染量尺寸，再决定留白宽度 —— 保证标签一定放得下、不被裁掉。
 *  4. 包围盒外扩 2% 再画线，避免箭头尖端顶到产品边缘。
 */

interface OverlaySpec {
  widthIn: number
  heightIn: number
  depthIn: number | null
  /** 底部图例（程序绘制）：长/宽/高/厚度等确认尺寸，如 L 12.0" W 8.0" H 15.0" T 2.0" */
  legend?: string | null
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

let smallFontPromise: Promise<any> | null = null
function getSmallFont(): Promise<any> {
  if (!smallFontPromise) smallFontPromise = Jimp.loadFont(Jimp.FONT_SANS_32_BLACK)
  return smallFontPromise
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

/** 把文字渲染到透明小图上并重新着色为 INK，返回图与尺寸（small=true 用 32px 字体画图例） */
async function renderText(text: string, small = false): Promise<{ img: Jimp; w: number; h: number }> {
  const font = await (small ? getSmallFont() : getFont())
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

/**
 * 画尺寸线 + 文字。
 *
 * 画布固定 1200×1200（ESP 上传要求），所以不能靠"往外扩画布"腾地方，
 * 而是反过来：**按包围盒把产品等比缩进可用区**，四周留出的白边正好用来画标注线。
 * 这样既不改变成品尺寸，又保证标注永远落在产品框外。
 */
export async function overlayDimensions(input: Buffer, spec: OverlaySpec): Promise<Buffer> {
  const src: Jimp = await Jimp.read(input).catch(() => {
    throw new AiError('尺寸图叠加失败：无法解析生成的图片')
  })

  // 1) 先量包围盒（必须在刷白之前：刷白会把"浅色产品 vs 浅灰底"的差异抹平）
  const raw = detectProductBox(src, 14)
  // 2) 统一成纯白背景（标注区必须是干净白底）
  normalizeWhiteBackground(src, 0.14)

  const S = CANVAS_SIZE
  const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1)

  const boxW = Math.max(1, raw.right - raw.left)
  const boxH = Math.max(1, raw.bottom - raw.top)

  // 3) 标注方向与图片里的实际朝向对齐：AI 摆放朝向不可控。
  //    必须在渲染文字之前定下来，否则数字和线会标反。
  let widthIn = spec.widthIn
  let heightIn = spec.heightIn
  if (
    (boxH > boxW * 1.15 && widthIn > heightIn * 1.15) ||
    (boxW > boxH * 1.15 && heightIn > widthIn * 1.15)
  ) {
    ;[widthIn, heightIn] = [heightIn, widthIn]
  }

  // 4) 先把文字渲染出来量尺寸，再反推可用区（保证标签一定放得下、不被裁）
  const wText = await renderText(`${fmt(widthIn)} in`)
  const hText = await renderText(`${fmt(heightIn)} in`)
  hText.img.rotate(90, true) // 顺时针 90°：文字自上而下
  const hw = hText.img.bitmap.width
  const hh = hText.img.bitmap.height
  // 长/宽/高/厚度图例（可选）：由程序绘制，数字只来自用户确认的尺寸数据
  const legendText = spec.legend?.trim() ? await renderText(spec.legend.trim(), true) : null
  const legendGap = legendText ? Math.round(S * 0.010) : 0
  const legendH = legendText ? legendText.h + legendGap : 0

  const gap = Math.round(S * 0.030) // 线到产品框的间距
  const basePad = Math.round(S * 0.030) // 画布最外边距
  const hasDepth = Boolean(spec.depthIn && spec.depthIn > 0)
  const depthPad = hasDepth ? Math.round(S * 0.11) : 0 // 左上斜深度线要的空间
  const padLeft = basePad + depthPad
  const padTop = basePad + depthPad
  const padRight = gap + 8 + hw + basePad
  const padBottom = gap + 8 + wText.h + legendH + basePad

  const availW = S - padLeft - padRight
  const availH = S - padTop - padBottom

  // 按包围盒（而不是整张图）缩放：产品能占到最大，图里原有的大片留白被消化掉
  const scale = Math.min(availW / boxW, availH / boxH)

  // 5) 画布固定 1200×1200：产品等比缩放后，包围盒在可用区内居中
  const canvas = new Jimp(S, S, WHITE_BG)
  const dw = Math.max(1, Math.round(src.bitmap.width * scale))
  const dh = Math.max(1, Math.round(src.bitmap.height * scale))
  const scaled = src.clone().scaleToFit(dw, dh)
  const destX = Math.round(padLeft + (availW - boxW * scale) / 2 - raw.left * scale)
  const destY = Math.round(padTop + (availH - boxH * scale) / 2 - raw.top * scale)
  canvas.composite(scaled, destX, destY)

  // 6) 缩放后产品框在画布上的位置（与 composite 用同一套取整）
  const left = destX + Math.round(raw.left * scale)
  const right = destX + Math.round(raw.right * scale)
  const top = destY + Math.round(raw.top * scale)
  const bottom = destY + Math.round(raw.bottom * scale)

  // 5) 底部：宽度线（落在产品框下方的白边里）
  const yW = Math.min(bottom + gap, S - basePad - 8 - wText.h - legendH)
  drawLine(canvas, left, yW, right, yW)
  drawArrow(canvas, left, yW, 'l')
  drawArrow(canvas, right, yW, 'r')
  {
    const tx = clamp(Math.round((left + right) / 2 - wText.w / 2), 2, S - wText.w - 2)
    const ty = clamp(yW + 8, 2, S - wText.h - legendH - 2)
    canvas.composite(wText.img, tx, ty)
  }

  // 5.1) 图例：长/宽/高/厚度等确认尺寸，程序绘制，保证数字准确
  if (legendText) {
    const lx = clamp(Math.round((S - legendText.w) / 2), 2, S - legendText.w - 2)
    const ly = clamp(yW + 8 + wText.h + legendGap, 2, S - legendText.h - 2)
    canvas.composite(legendText.img, lx, ly)
  }

  // 6) 右侧：高度线（落在产品框右侧的白边里，文字旋转 90°）
  const xH = Math.min(right + gap, S - basePad - 8 - hw)
  drawLine(canvas, xH, top, xH, bottom)
  drawArrow(canvas, xH, top, 'u')
  drawArrow(canvas, xH, bottom, 'd')
  {
    const tx = clamp(xH + 8, 2, S - hw - 2)
    const ty = clamp(Math.round((top + bottom) / 2 - hh / 2), 2, S - hh - 2)
    canvas.composite(hText.img, tx, ty)
  }

  // 7) 左上：深度线（斜 45°，只在留白够时画）
  if (hasDepth && spec.depthIn) {
    const d = Math.round(S * 0.09)
    const x1 = left
    const y1 = top
    const x2 = x1 - d
    const y2 = y1 - d
    if (x2 > 6 && y2 > 6) {
      drawLine(canvas, x1, y1, x2, y2)
      drawArrow(canvas, x2, y2, 'u')
      const t = await renderText(`${fmt(spec.depthIn)} in`)
      const tx = clamp(x2 - t.w - 6, 2, S - t.w - 2)
      const ty = clamp(y2 - t.h - 6, 2, S - t.h - 2)
      canvas.composite(t.img, tx, ty)
    }
  }

  return canvas.getBufferAsync(Jimp.MIME_PNG)
}
