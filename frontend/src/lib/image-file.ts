/**
 * 浏览器端把「粘贴/拖入/选择的图片文件」压成 data URL。
 *
 * 为什么要压：截图/手机照片动辄 3-8MB，直接 base64 上传会撞接口体积上限、
 * 存进数据库也浪费空间。统一压到最长边 1600px 的 JPEG（约 200-500KB），
 * 肉眼看不出差别，但足够给 AI 当参考图。
 */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片打不开（格式不支持？试试 PNG / JPG）'))
    img.src = src
  })
}

/** 单张文件 → JPEG data URL（白底，避免透明 PNG 转 JPEG 变黑） */
export async function fileToDataUrl(file: File, maxDim = 1600, quality = 0.88): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('不是图片文件')
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('浏览器不支持 canvas')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', quality)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 多张文件 → data URL 列表（单张失败跳过，table 里不出错） */
export async function filesToDataUrls(files: File[], maxDim = 1600, quality = 0.88): Promise<string[]> {
  const out: string[] = []
  for (const f of files.filter((x) => x.type.startsWith('image/'))) {
    try {
      out.push(await fileToDataUrl(f, maxDim, quality))
    } catch {
      /* 单张失败不影响其他张 */
    }
  }
  return out
}
