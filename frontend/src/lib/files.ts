/**
 * 前端文件小工具。
 *
 * 只做「把本地文件读成 data URL」这一件事：上传压缩在服务端做（Jimp），
 * 前端不引图形库、也不预压缩，避免两套口径。
 */

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/** 从 FileList / 数组里挑出图片文件（非图片直接忽略） */
export function pickImageFiles(files: FileList | File[] | null): File[] {
  if (!files) return []
  return Array.from(files).filter((f) => f.type.startsWith('image/'))
}

/** 一次最多几张：超过只提示，不静默截断，避免用户以为传全了 */
export const UPLOAD_BATCH_LIMIT = 12
/** 单张上限（服务端会压到 1600px，太大的原图先拦下来省一次往返） */
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024

/**
 * 分批：一次请求最多带 3 张。
 * base64 会让图片体积涨 33%，10 张 5MB 的原图能撑到 60MB+，
 * 网关（Render 代理）和我们的 JSON 限制都吃不消，所以宁可多请求几次。
 */
export function chunkImages<T>(items: T[], size = 3): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
