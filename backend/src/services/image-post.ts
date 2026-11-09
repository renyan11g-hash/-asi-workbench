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
 * 连通式背景净化：只刷「从图片边缘能连通到」的浅色像素。
 *
 * 为什么需要：模型常给「米黄/浅灰 + 渐变」的底，review 某次就卡在
 * 「背景非纯白 #FFFFFF，整体偏米黄并带渐变」。只清外圈清不到中间的渐变，
 * 全图按亮度刷又会把产品里的浅色部分（白色/米色面料）一起吃掉。
 * 从四条边做连通泛洪，只吃与边缘同属一片浅背景的像素，产品内部浅色区域不会被误伤。
 */
export function whitenConnectedBackground(
  img: Jimp,
  opts: { minLight?: number; maxChroma?: number; maxDist?: number } = {}
): number {
  const { width, height, data } = img.bitmap
  const minLight = opts.minLight ?? 218
  const maxChroma = opts.maxChroma ?? 32
  const maxDist = opts.maxDist ?? 55
  const bg = estimateBackgroundColor(img)
  const visited = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0

  const qualifies = (idx: number): boolean => {
    const i = idx * 4
    if (data[i + 3] < 8) return true // 透明＝背景
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (Math.min(r, g, b) < minLight) return false
    if (Math.max(r, g, b) - Math.min(r, g, b) > maxChroma) return false
    const dr = r - bg.r
    const dg = g - bg.g
    const db = b - bg.b
    return dr * dr + dg * dg + db * db <= maxDist * maxDist
  }
  const push = (idx: number) => {
    if (visited[idx] || !qualifies(idx)) return
    visited[idx] = 1
    queue[tail++] = idx
  }

  for (let x = 0; x < width; x++) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    push(y * width)
    push(y * width + width - 1)
  }

  let n = 0
  while (head < tail) {
    const idx = queue[head++]
    const i = idx * 4
    data[i] = 255
    data[i + 1] = 255
    data[i + 2] = 255
    data[i + 3] = 255
    n++
    const x = idx % width
    const y = (idx - x) / width
    if (x > 0) push(idx - 1)
    if (x < width - 1) push(idx + 1)
    if (y > 0) push(idx - width)
    if (y < height - 1) push(idx + width)
  }
  return n
}

/**
 * 统一成纯白背景（主图 / 尺寸图共用）。
 *
 * 分四档，都是根据"背景有多白"来定策略，尽量只动背景不动产品：
 *   · 背景已接近纯白（≥236）→ 只清理外圈，产品一个像素都不碰（最容易误伤的情况直接跳过）
 *   · 背景是浅灰（215-235）→ 外圈 + 以 12 的容差全图刷一遍。
 *     白色产品（255）与浅灰底（如 240）的距离是 26，远大于 12，所以不会被吃掉。
 *   · 背景是彩色/深色 → 只清理外圈（说明 AI 没按白底出图，改提示词或让用户用 AI 修改）
 *   · 浅色但不纯（米黄/浅灰渐变，minC≥200）→ 再从边缘做一次连通泛洪，
 *     把与边缘连成一片的浅色渐变全部刷成 #FFFFFF，产品内部的浅色区域保持不动。
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
  // 浅色渐变底（米黄/浅灰）再过一遍连通泛洪：这是 ASI 目录审核最常卡的「背景不纯白」。
  // 每次主图/尺寸图都跑：门槛（minLight=218 + 低彩度）保证深色/彩色底面一个像素都不动，
  // 四角取样估出来的背景色可能是纯白（外圈已被清理），所以不能拿它来决定要不要跑。
  whitenConnectedBackground(img)
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

/**
 * 「原图直出」主图：保住产品真身，只换背景。
 *
 * 为什么需要：文生图再强也可能改结构/颜色。当保真优先于美化时，直接拿 1688 实拍图，
 * 从四边泛洪把「与边缘背景色接近」的区域刷成纯白，再把产品等比放进 1200×1200 白底画布。
 * 产品像素本身一个都不重绘，因此结构/颜色/Logo/配件 100% 不会变。
 *
 * 泛洪只从画布边缘出发：产品内部的同色区域（例如白色杯身内部）不会被连通，不会被误刷。
 */
export async function composeWhiteMain(input: Buffer): Promise<Buffer> {
  const img = await Jimp.read(input).catch(() => null)
  if (!img) return input
  const { width, height, data } = img.bitmap
  const bg = estimateBackgroundColor(img)
  const tol = 36

  const visited = new Uint8Array(width * height)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const p = y * width + x
    if (visited[p]) return
    const i = p * 4
    if (!isBgPixel(data, i, bg, tol)) return
    visited[p] = 1
    stack.push(p)
  }
  for (let x = 0; x < width; x++) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    push(0, y)
    push(width - 1, y)
  }
  let filled = 0
  while (stack.length) {
    const p = stack.pop() as number
    const i = p * 4
    data[i] = 255
    data[i + 1] = 255
    data[i + 2] = 255
    data[i + 3] = 255
    filled++
    const x = p % width
    const y = (p - x) / width
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }

  const ratio = filled / (width * height)
  // 背景几乎刷不掉（复杂场景图/深色底）：说明不是白底实拍，退化为只清外圈，产品仍不改
  if (ratio < 0.12) return finalizeMainImage(await img.getBufferAsync(Jimp.MIME_PNG), 0.06)

  // 刷完后的产品包围盒（此时背景是纯白）
  const box = detectProductBox(img, 18)
  const padX = Math.max(2, Math.round((box.right - box.left) * 0.04))
  const padY = Math.max(2, Math.round((box.bottom - box.top) * 0.04))
  const cropW = Math.max(1, Math.min(width, box.right - box.left + padX * 2))
  const cropH = Math.max(1, Math.min(height, box.bottom - box.top + padY * 2))
  const cropX = Math.max(0, Math.min(width - cropW, box.left - padX))
  const cropY = Math.max(0, Math.min(height - cropH, box.top - padY))

  const cropped = img.clone().crop(cropX, cropY, cropW, cropH)
  // 四周留 8% 空白，产品居中，整体 1200×1200
  const inner = Math.round(CANVAS_SIZE * 0.84)
  const scaled = cropped.scaleToFit(inner, inner)
  const canvas = new Jimp(CANVAS_SIZE, CANVAS_SIZE, 0xffffffff)
  canvas.composite(
    scaled,
    Math.round((CANVAS_SIZE - scaled.bitmap.width) / 2),
    Math.round((CANVAS_SIZE - scaled.bitmap.height) / 2)
  )
  return canvas.getBufferAsync(Jimp.MIME_PNG)
}
