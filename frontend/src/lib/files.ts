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

/** 一个文件夹 = 一款产品的图（用户的习惯：文件夹名就是产品名） */
export interface ImageFolderGroup {
  folder: string
  files: File[]
}

const NO_FOLDER = '（未分文件夹）'

/** 按顶层文件夹分组：选文件夹时浏览器会给 webkitRelativePath =「文件夹/子目录/文件名」 */
export function groupFilesByFolder(files: File[]): ImageFolderGroup[] {
  const map = new Map<string, File[]>()
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || ''
    const seg = rel.split('/').filter(Boolean)
    const folder = seg.length > 1 ? seg[0] : NO_FOLDER
    const arr = map.get(folder) ?? []
    arr.push(f)
    map.set(folder, arr)
  }
  return [...map.entries()]
    .map(([folder, list]) => ({ folder, files: list }))
    .sort((a, b) => a.folder.localeCompare(b.folder, 'zh'))
}

/** 目录读取器一次最多返回 100 条，要一直读到空 */
async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const out: FileSystemEntry[] = []
  for (let guard = 0; guard < 200; guard++) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) =>
      reader.readEntries((r) => resolve(r), () => resolve([]))
    )
    if (!batch.length) break
    out.push(...batch)
  }
  return out
}

function fileOf(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file((f) => resolve(f), () => resolve(null)))
}

async function walk(entry: FileSystemEntry, sink: File[]): Promise<void> {
  if (entry.isFile) {
    const f = await fileOf(entry as FileSystemFileEntry)
    if (f && (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name))) sink.push(f)
    return
  }
  if (entry.isDirectory) {
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) await walk(child, sink)
  }
}

/**
 * 拖进来的可能是「多个文件夹」也可能是「一堆图片」：
 * 文件夹按顶层名字分组（一个文件夹 = 一款产品的图），散图归到「未分文件夹」。
 */
export async function collectDroppedFolders(dt: DataTransfer | null): Promise<ImageFolderGroup[]> {
  if (!dt) return []
  const entries = Array.from(dt.items ?? [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.() ?? null)
    .filter((e): e is FileSystemEntry => Boolean(e))

  if (!entries.length) {
    const files = pickImageFiles(dt.files)
    return files.length ? [{ folder: NO_FOLDER, files }] : []
  }

  const groups: ImageFolderGroup[] = []
  const loose: File[] = []
  for (const e of entries) {
    if (e.isDirectory) {
      const files: File[] = []
      await walk(e, files)
      if (files.length) groups.push({ folder: e.name, files })
    } else if (e.isFile) {
      const f = await fileOf(e as FileSystemFileEntry)
      if (f && f.type.startsWith('image/')) loose.push(f)
    }
  }
  if (loose.length) groups.push({ folder: NO_FOLDER, files: loose })
  return groups.sort((a, b) => a.folder.localeCompare(b.folder, 'zh'))
}
