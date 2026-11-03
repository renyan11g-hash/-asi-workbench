import Jimp from 'jimp'

/**
 * 出图后处理（纯本地像素操作，不再调 AI）：
 *  1. 统一成**纯白背景** —— 生图模型经常给一点点灰底/渐变，ASI 目录要求纯白
 *  2. 统一成**固定 1200×1200 画布** —— ESP 上传要求方图，画布尺寸不能随生图结果浮动
 *  3. 检测产品包围盒 —— 尺寸图要靠它把标注线画在产品外面，不能压在产品上
 *
 * 刷白为什么分档：白色产品和白背景同色，无脑泛洪会把产品本身的浅色边缘一起吃掉。
 * 所以先估背景有多白，再决定是「只清外圈」还是「小容差全图刷」，彩色底一律不动。
 */

/** 固定画布边长（像素）。ESP 要求方图，前端展示也按方图裁切，所以统一到这个尺寸 */
export const CANVAS_SIZE = Number(process.env.IMAGE_CANVAS_SIZE) || 1200

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** 四角取样估背景色（取中位数，避免某一角有阴影把估计带偏） */
export function estimateBackgroundColor(img: Jimp): { r: number; g: number; b: number } {
  const { width, height, data } = img.bitmap
  const pick = (x: number, y: number) => {
    const i = (y * width + x) * 4
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }
  const pts = [
    pick(1, 1),
    pick(width - 2, 1),
    pick(1, height - 2),
    pick(width - 2, height - 2),
    pick(Math.round(width / 2), 1),
    pick(Math.round(width / 2), height - 2),
  ].filter((p) => p[3] > 8)
  if (!pts.length) return { r: 255, g: 255, b: 255 }
  const median = (idx: number) => {
    const v = pts.map((p) => p[idx]).sort((a, b) => a - b)
    return v[Math.floor(v.length / 2)]
  }
  return { r: median(0), g: median(1), b: median(2) }
}

function isBgPixel(
  data: Buffer,
  i: number,
  bg: { r: number; g: number; b: number },
  tol: number
): boolean {
  if (data[i + 3] < 8) return true // 透明＝背景
  const dr = data[i] - bg.r
  const dg = data[i + 1] - bg.g
  const db = data[i + 2] - bg.b
  return Math.sqrt(dr * dr + dg * dg + db * db) <= tol
}

/**
 * 把外圈空白刷成纯白。
 * @param ratio 外圈带宽（占图片宽/高的比例），提示词保证这里是空白边距
 * @param tol 与背景色的最大色差（0-441），越大越激进
 * @returns 被刷白的像素数
 */
export function whitenOuterBand(img: Jimp, ratio = 0.14, tol = 32): number {
  const { width, height, data } = img.bitmap
  const bg = estimateBackgroundColor(img)
  const bw = Math.max(4, Math.round(width * ratio))
  const bh = Math.max(4, Math.round(height * ratio))
  let n = 0
  const white = (i: number) => {
    data[i] = 255
    data[i + 1] = 255
    data[i + 2] = 255
    data[i + 3] = 255
    n++
  }
  for (let y = 0; y < height; y++) {
    const inTopBottom = y < bh || y >= height - bh
    for (let x = 0; x < bw; x++) {
      const i = (y * width + x) * 4
      if (isBgPixel(data, i, bg, tol)) white(i)
      const j = (y * width + (width - 1 - x)) * 4
      if (isBgPixel(data, j, bg, tol)) white(j)
    }
    if (inTopBottom) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        if (isBgPixel(data, i, bg, tol)) white(i)
      }
    }
  }
  return n
}

/** 按给定背景色全图刷白（小容差，只吃背景不吃产品） */
function whitenNearBackground(
  img: Jimp,
  bg: { r: number; g: number; b: number },
  tol: number
): number {
  const { width, height, data } = img.bitmap
  let n = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (!isBgPixel(data, i, bg, tol)) continue
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = 255
      n++
    }
  }
  return n
}

/**
 * 统一成纯白背景（主图 / 尺寸图共用）。
 *
 * 分三档，都是根据"背景有多白"来定策略，尽量只动背景不动产品：
 *   · 背景已接近纯白（≥236）→ 只清理外圈，产品一个像素都不碰（最容易误伤的情况直接跳过）
 *   · 背景是浅灰（215-235）→ 外圈 + 以 12 的容差全图刷一遍。
 *     白色产品（255）与浅灰底（如 240）的距离是 26，远大于 12，所以不会被吃掉。
 *   · 背景是彩色/深色 → 只清理外圈（说明 AI 没按白底出图，改提示词或让用户用 AI 修改）
 */
export function normalizeWhiteBackground(img: Jimp, bandRatio = 0.10): void {
  const bg = estimateBackgroundColor(img)
  const minC = Math.min(bg.r, bg.g, bg.b)
  const maxC = Math.max(bg.r, bg.g, bg.b)
  whitenOuterBand(img, bandRatio, 18)
  // 白色产品是 255：要保证它离背景色 > 12 才不会被一起刷白，
  // 所以背景亮度上限卡在 245（255-245=10 → 欧氏距离 17.3 > 12）。
  // 245-254 的"几乎就是白"的背景只清外圈，避免误伤白色产品。
  const lightGreyCast = minC >= 200 && minC <= 245 && maxC <= 250
  if (lightGreyCast) {
    whitenNearBackground(img, bg, 12)
  }
}

/** Buffer 入口：读图 → 统一白底 → 统一 1200×1200（主图用） */
export async function finalizeMainImage(buf: Buffer, bandRatio = 0.10): Promise<Buffer> {
  const img = await Jimp.read(buf).catch(() => null)
  if (!img) return buf // 解析不了就原样返回，绝不因为后处理把生成结果弄丢
  normalizeWhiteBackground(img, bandRatio)
  const squared = fitToCanvas(img)
  return squared.getBufferAsync(Jimp.MIME_PNG)
}

/**
 * 把图片等比缩放后居中放进固定画布（默认 1200×1200）：
 * 不裁切、不变形，四周补纯白。已经是目标尺寸时直接返回，避免二次编码损失。
 */
export function fitToCanvas(img: Jimp, size = CANVAS_SIZE): Jimp {
  const W = img.bitmap.width
  const H = img.bitmap.height
  if (W === size && H === size) return img
  const canvas = new Jimp(size, size, 0xffffffff)
  const s = Math.min(size / W, size / H)
  const w = Math.max(1, Math.round(W * s))
  const h = Math.max(1, Math.round(H * s))
  const scaled = s === 1 ? img : img.clone().scaleToFit(w, h)
  canvas.composite(scaled, Math.round((size - scaled.bitmap.width) / 2), Math.round((size - scaled.bitmap.height) / 2))
  return canvas
}

/**
 * 检测产品包围盒：与背景色差超过 tol 的像素范围。
 *
 * 用「与背景色的距离」而不是「是否够白」来判断，是为了处理浅色产品：
 * 白色产品（255）放在浅灰底（242）上时，按住"是否 >=244"来判会把它整只当成背景，
 * 于是包围盒退化成中央区域，标注线就可能压到产品上。
 *
 * 注意：必须在 normalizeWhiteBackground 之前调用（刷白之后背景和浅色产品的差异会被抹平）。
 */
export function detectProductBox(img: Jimp, tol = 14): Box {
  const { width, height, data } = img.bitmap
  const bg = estimateBackgroundColor(img)
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] < 24) continue // 透明
      if (isBgPixel(data, i, bg, tol)) continue // 背景
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < 0) {
    // 全图与背景同色（例如纯白产品放在纯白底上，没有可辨轮廓）：
    // 退化为中央 60% 区域，标注线仍然画在框外的留白里
    return {
      left: Math.round(width * 0.2),
      top: Math.round(height * 0.2),
      right: Math.round(width * 0.8),
      bottom: Math.round(height * 0.8),
    }
  }
  return { left, top, right, bottom }
}

/** 包围盒外扩若干像素（保证标注线不贴产品边缘） */
export function inflateBox(box: Box, px: number, width: number, height: number): Box {
  return {
    left: Math.max(0, box.left - px),
    top: Math.max(0, box.top - px),
    right: Math.min(width - 1, box.right + px),
    bottom: Math.min(height - 1, box.bottom + px),
  }
}
