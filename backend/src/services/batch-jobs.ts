/**
 * 批量处理任务：数据模型 + 粘贴文本解析 + 落库读写。
 *
 * 这里只管两件事：① 一坨文本怎么变成 N 条待处理产品；② 任务状态怎么存。
 * 具体怎么跑（抓取/评估/入库）全部复用单品流程的同一批函数，见 modules/batch.ts。
 * 单品规则的任何参数都不在这里改。
 *
 * 阶段（phase）对应单品页的操作顺序，一步都不能省：
 *   draft     刚粘进来
 *   fetched   资料已抓取 → **人工补全箱规等 1688 抓不到的字段** → 才能评估
 *   evaluated 已评估（未落库）
 *   saved     已入库（产品库里能看到了）
 */

import { db } from '../db'
import type { SourceInfo } from '../types'

/** 单条产品的处理阶段（前端按这个显示 badge） */
export type BatchItemStatus =
  | 'pending'
  | 'fetching'
  | 'fetched'
  | 'evaluating'
  | 'evaluated'
  | 'saving'
  | 'listing'
  | 'done'
  | 'error'
  | 'skipped'

export type BatchJobStatus = 'draft' | 'running' | 'done' | 'cancelled' | 'interrupted'
export type BatchPhase = 'draft' | 'fetched' | 'evaluated' | 'saved'

/** 手填资料：全部可选，填了就覆盖 1688 抓取到的同名字段 */
export interface BatchItemInput {
  title?: string
  priceCny?: number | null
  moq?: number | null
  sizeCn?: string
  materialCn?: string
  colorsCn?: string
  description?: string
  /** 产品图（可多张）：补全时手动加，或从 1688 一键抓取 */
  images?: string[]
  /** 单件重（克） */
  weightG?: number | null
  /** 箱规长宽高（厘米） */
  cartonLCm?: number | null
  cartonWCm?: number | null
  cartonHCm?: number | null
  /** 每箱装多少个 */
  pcsPerCarton?: number | null
  /** 整箱毛重（公斤） */
  cartonGwKg?: number | null
}

export interface BatchItem {
  idx: number
  /** 1688 链接；手动商品可以没有 */
  url: string
  input: BatchItemInput
  status: BatchItemStatus
  /** 当前步骤的人话描述 */
  stage: string
  /** 标题（抓取或手填后回填，便于前端展示） */
  title?: string
  /** 抓取 + 手填合并后的完整源信息（评估与入库都用它，也是补全表单的初值） */
  source?: SourceInfo | null
  /** 还缺哪些字段（箱规这类 1688 抓不到的），前端标黄提醒 */
  missing?: string[]
  /** 是否已评估过（评估结果单独存表） */
  evaluated?: boolean
  /** 抓取失败的提示（仍可能继续评估） */
  warn?: string
  error?: string
  score?: number | null
  verdict?: string | null
  marketNote?: string | null
  productId?: string | null
  /** 抓到哪些字段，前端展示「抓取 5 项」 */
  fetchedFields?: string[]
  updatedAt?: string
}

export interface BatchOptions {
  /** 抓取 1688 详情（需要链接） */
  fetch: boolean
  /** AI 评估（评分 + 结论 + 海外同款 + 阶梯报价） */
  evaluate: boolean
  /** 保存到产品库 */
  save: boolean
  /** 生成英文 listing（会自动要求保存到产品库） */
  listing: boolean
}

export interface BatchJob {
  id: string
  status: BatchJobStatus
  phase: BatchPhase
  options: BatchOptions
  items: BatchItem[]
  note: string
  createdAt: string
  updatedAt: string
}

export const DEFAULT_BATCH_OPTIONS: BatchOptions = {
  fetch: true,
  evaluate: true,
  save: true,
  listing: false,
}

/** 单批上限：再多就不是「批量」而是压测了（每条约 30~90 秒） */
export const MAX_BATCH_ITEMS = 50

/**
 * 评估前必须有的字段。这些 1688 页面基本抓不到（箱规/每箱数/箱毛重尤甚），
 * 缺了就只能按默认值估算运费，分数会骗人 —— 所以要在界面上逼着补。
 */
const REQUIRED_BEFORE_EVAL: Array<{ label: string; has: (s: SourceInfo) => boolean }> = [
  { label: '采购价', has: (s) => Number(s.priceCny) > 0 },
  { label: '产品尺寸', has: (s) => Boolean((s.sizeCn ?? '').trim()) },
  { label: '材质', has: (s) => Boolean((s.materialCn ?? '').trim()) },
  {
    label: '箱规',
    has: (s) => Boolean(s.cartonLCm && s.cartonWCm && s.cartonHCm),
  },
  { label: '每箱数量', has: (s) => Boolean(s.pcsPerCarton) },
  { label: '箱毛重', has: (s) => Boolean(s.cartonGwKg) },
]

/** 算出还缺哪些关键字段（中文名，直接给用户看） */
export function missingFields(source: SourceInfo | null | undefined): string[] {
  if (!source) return REQUIRED_BEFORE_EVAL.map((f) => f.label)
  return REQUIRED_BEFORE_EVAL.filter((f) => !f.has(source)).map((f) => f.label)
}

/** 这条能不能评估：至少要有个标题 */
export function canEvaluate(item: BatchItem): boolean {
  const title = (item.source?.sourceTitle ?? item.input.title ?? '').trim()
  return Boolean(title)
}

// ---------------------------------------------------------------- 解析

type ColKey = keyof BatchItemInput | 'url' | 'carton'

/** 表头别名：中英文都认。检测顺序就是这里的书写顺序，「装箱尺寸」要先于「尺寸」 */
const COLUMN_ALIASES: Array<[ColKey, RegExp[]]> = [
  ['url', [/^url$/i, /链接/, /^link$/i, /地址/]],
  ['carton', [/箱规/, /外箱/, /装箱尺寸/, /包装尺寸/, /^carton/i]],
  ['pcsPerCarton', [/每箱/, /装箱数/, /^pcs/i, /^qty.*carton/i]],
  ['cartonGwKg', [/毛重/, /^gw$/i, /^gross/i]],
  ['weightG', [/单件重/, /净重/, /^weight/i, /克重/, /^重量/]],
  ['title', [/标题/, /品名/, /^title$/i, /名称/, /product/i]],
  ['priceCny', [/采购价/, /单价/, /价格/, /^price$/i, /进货价/]],
  ['moq', [/^moq$/i, /起订/, /起批/]],
  ['sizeCn', [/尺寸/, /^size$/i, /规格/]],
  ['materialCn', [/材质/, /^material/i]],
  ['colorsCn', [/颜色/, /^colou?r/i]],
  ['description', [/描述/, /卖点/, /^description$/i, /详情/, /备注/, /^remark/i]],
]

/** 固定列序（无表头时按这个位置取），与界面提示保持一致 */
const POSITIONAL: ColKey[] = [
  'url',
  'title',
  'priceCny',
  'moq',
  'sizeCn',
  'materialCn',
  'colorsCn',
  'carton',
  'pcsPerCarton',
  'cartonGwKg',
  'weightG',
  'description',
]

const URL_RE = /https?:\/\/[^\s|,，、]+/i
const CARTON_RE = /(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)/

function splitCells(line: string): string[] {
  // Tab 优先（从 Excel 直接粘贴就是 Tab），其次竖线；逗号不切：标题里常带逗号
  if (line.includes('\t')) return line.split('\t')
  if (line.includes('|')) return line.split('|')
  return [line]
}

function detectHeader(cells: string[]): ColKey[] | null {
  if (cells.length < 2) return null
  const keys = cells.map((c) => {
    const t = c.trim()
    if (!t) return null
    for (const [key, res] of COLUMN_ALIASES) {
      if (res.some((re) => re.test(t))) return key
    }
    return null
  })
  const hit = keys.filter(Boolean).length
  if (hit < 2) return null
  return keys as ColKey[]
}

function num(v: string | undefined): number | null {
  if (!v) return null
  const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

function text(v: string | undefined): string {
  return (v ?? '').trim()
}

export interface ParsedRow {
  url: string
  input: BatchItemInput
}

export interface ParseIssue {
  line: number
  text: string
  error: string
}

export interface ParseResult {
  rows: ParsedRow[]
  issues: ParseIssue[]
  duplicates: string[]
  /** 没有链接、只有标题的行数（纯手动录入） */
  manualCount: number
}

/**
 * 把粘贴进来的文本切成一条条待处理产品。
 *
 * 支持的写法（一行一个产品）：
 *   https://detail.1688.com/offer/123.html
 *   https://detail.1688.com/offer/123.html	收纳盒	3.5	100	20x15x8cm	PU皮	黑/灰	40x30x25	60	12	180
 *   收纳盒	3.5	100            ← 没有链接也行，纯手动录入
 * 第一行如果是表头（含「链接/标题/价格/箱规」等），按表头映射列，否则按固定列序。
 */
export function parseBatchInput(raw: string): ParseResult {
  const rows: ParsedRow[] = []
  const issues: ParseIssue[] = []
  const duplicates: string[] = []
  const seen = new Set<string>()
  let mapping: ColKey[] | null = null
  let manualCount = 0
  let headerChecked = false

  const lines = raw.split(/\r?\n/)
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed) return
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) return

    const cells = splitCells(trimmed).map((c) => c.trim())

    if (!headerChecked) {
      headerChecked = true
      const header = detectHeader(cells)
      if (header) {
        mapping = header
        return
      }
    }

    // 表头常把「链接」放在第一列，但用户也可能整行只写标题（手动录入）。
    // 这一行没有任何 http 链接时：链接列若为空就去掉这一格，其余列整体左移；
    // 若链接格里写的是标题，则把它当标题列用 —— 不能因为"不是链接"就丢掉整行。
    let order = mapping ?? POSITIONAL
    let rowCells = cells
    const urlIdx = order.indexOf('url')
    const hasHttpCell = cells.some((c) => /^https?:\/\//i.test(c))
    if (urlIdx >= 0 && !hasHttpCell) {
      if (!text(cells[urlIdx])) rowCells = cells.filter((_, ci) => ci !== urlIdx)
      order = order.filter((k) => k !== 'url')
    }

    const keyed: Partial<Record<ColKey, string>> = {}
    rowCells.forEach((cell, ci) => {
      const key = order[ci]
      if (key && cell) keyed[key] = cell
    })

    let url = text(keyed.url)
    let titleRaw = text(keyed.title)
    if (url && !/^https?:\/\//i.test(url)) {
      if (!titleRaw) titleRaw = url
      else {
        issues.push({ line: i + 1, text: trimmed, error: '链接格式不对（要以 http 开头）' })
        return
      }
      url = ''
    }
    // URL 可能被粘在标题列里（比如直接复制整行富文本）：全行再兜一次
    if (!url) {
      const m = trimmed.match(URL_RE)
      if (m) url = m[0]
    }
    url = url.replace(/[)）】。，,、；;]+$/, '')
    if (url && !/^https?:\/\//i.test(url)) {
      issues.push({ line: i + 1, text: trimmed, error: '链接格式不对（要以 http 开头）' })
      return
    }

    const title = titleRaw || (url ? '' : trimmed.replace(URL_RE, '').trim())
    if (!url && !title) {
      issues.push({ line: i + 1, text: trimmed, error: '既没有链接也没有标题' })
      return
    }

    const dedupeKey = url
      ? (url.match(/offer\/(\d{6,})/)?.[1] ?? url.toLowerCase())
      : `manual:${title}`
    if (seen.has(dedupeKey)) {
      duplicates.push(url || title)
      return
    }
    seen.add(dedupeKey)
    if (!url) manualCount += 1

    // 箱规一格写 "40x30x20" 时拆成 L/W/H
    const cartonCell = text(keyed.carton)
    const carton = cartonCell.match(CARTON_RE)

    // 只放「真的填了」的字段：留空就不要写进 input，否则会把抓取到的值覆盖成空
    const input: BatchItemInput = {}
    const put = <K extends keyof BatchItemInput>(k: K, v: BatchItemInput[K]) => {
      if (v === undefined || v === null || v === '') return
      input[k] = v
    }
    put('title', title || undefined)
    put('priceCny', num(keyed.priceCny))
    put('moq', num(keyed.moq))
    put('sizeCn', text(keyed.sizeCn) || undefined)
    put('materialCn', text(keyed.materialCn) || undefined)
    put('colorsCn', text(keyed.colorsCn) || undefined)
    put('cartonLCm', carton ? Number(carton[1]) : null)
    put('cartonWCm', carton ? Number(carton[2]) : null)
    put('cartonHCm', carton ? Number(carton[3]) : null)
    put('pcsPerCarton', num(keyed.pcsPerCarton))
    put('cartonGwKg', num(keyed.cartonGwKg))
    put('weightG', num(keyed.weightG))
    put('description', text(keyed.description) || undefined)

    rows.push({ url, input })
  })

  return { rows, issues, duplicates, manualCount }
}

// ---------------------------------------------------------------- 落库

interface Row {
  id: string
  status: string
  phase: string | null
  options: string
  items: string
  note: string
  created_at: string
  updated_at: string
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

function rowToJob(r: Row): BatchJob {
  return {
    id: r.id,
    status: r.status as BatchJobStatus,
    phase: (r.phase as BatchPhase) ?? 'draft',
    options: { ...DEFAULT_BATCH_OPTIONS, ...safeJson<Partial<BatchOptions>>(r.options, {}) },
    items: safeJson<BatchItem[]>(r.items, []),
    note: r.note ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * 产品图单独存一张表（batch_item_images）。
 *
 * 原因：资料库命中时 item.source.images 里是 data URL，一张 50–130KB。
 * 批量任务每改一条进度都会把整个 items 数组序列化写回 batch_jobs.items，
 * 图塞在里面的话一次进度更新就是几 MB～几十 MB，写库会超时、入库还会失败。
 *
 * 这里维护一份「每条图 JSON」的内存指纹，内容没变就不重复写。
 */
const imageCache = new Map<string, Map<number, string>>()

function persistItemImages(job: BatchJob, now: string): void {
  let cache = imageCache.get(job.id)
  if (!cache) {
    cache = new Map<number, string>()
    imageCache.set(job.id, cache)
  }
  const seen = new Set<number>()
  for (const it of job.items) {
    const imgs = it.source?.images ?? []
    if (!imgs.length) continue
    seen.add(it.idx)
    const json = JSON.stringify(imgs)
    if (cache.get(it.idx) === json) continue
    db.prepare(
      'INSERT INTO batch_item_images (job_id, idx, images, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(job_id, idx) DO UPDATE SET images=excluded.images, updated_at=excluded.updated_at'
    ).run(job.id, it.idx, json, now)
    cache.set(it.idx, json)
  }
  // 条目被删掉、或图被清空的，同步清掉
  for (const idx of Array.from(cache.keys())) {
    if (seen.has(idx)) continue
    db.prepare('DELETE FROM batch_item_images WHERE job_id = ? AND idx = ?').run(job.id, idx)
    cache.delete(idx)
  }
}

/** 读回一条任务的所有产品图，塞回 item.source.images */
function hydrateItemImages(job: BatchJob): void {
  let rows: Array<{ idx: number; images: string }>
  try {
    rows = db
      .prepare('SELECT idx, images FROM batch_item_images WHERE job_id = ?')
      .all(job.id) as unknown as Array<{ idx: number; images: string }>
  } catch {
    return
  }
  if (!rows.length) return
  let cache = imageCache.get(job.id)
  if (!cache) {
    cache = new Map<number, string>()
    imageCache.set(job.id, cache)
  }
  const byIdx = new Map<number, string[]>()
  for (const r of rows) {
    const imgs = safeJson<string[]>(r.images, [])
    if (imgs.length) byIdx.set(Number(r.idx), imgs)
  }
  for (const it of job.items) {
    const imgs = byIdx.get(it.idx)
    if (!imgs) continue
    if (it.source) it.source = { ...it.source, images: imgs }
    cache.set(it.idx, JSON.stringify(imgs))
  }
}

export function createBatchJob(options: BatchOptions, items: BatchItem[], note = ''): BatchJob {
  const id = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO batch_jobs (id, status, phase, options, items, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'draft', 'draft', JSON.stringify(options), JSON.stringify(items), note, now, now)
  return {
    id,
    status: 'draft',
    phase: 'draft',
    options,
    items,
    note,
    createdAt: now,
    updatedAt: now,
  }
}

export function saveBatchJob(job: BatchJob): void {
  const now = new Date().toISOString()
  job.updatedAt = now
  // 图先单独落表，写进 items 的只有「空数组」占位，避免每次进度更新都重写几 MB
  persistItemImages(job, now)
  const slimItems = job.items.map((it) =>
    it.source && it.source.images.length ? { ...it, source: { ...it.source, images: [] } } : it
  )
  db.prepare(
    'UPDATE batch_jobs SET status=?, phase=?, options=?, items=?, note=?, updated_at=? WHERE id=?'
  ).run(
    job.status,
    job.phase,
    JSON.stringify(job.options),
    JSON.stringify(slimItems),
    job.note,
    now,
    job.id
  )
}

export function getBatchJob(id: string): BatchJob | null {
  const row = db.prepare('SELECT * FROM batch_jobs WHERE id = ?').get(id) as unknown as Row | undefined
  if (!row) return null
  const job = rowToJob(row)
  hydrateItemImages(job)
  return job
}

export function listBatchJobs(limit = 10): BatchJob[] {
  const rows = db
    .prepare('SELECT * FROM batch_jobs ORDER BY created_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(50, limit))) as unknown as Row[]
  return rows.map(rowToJob)
}

export function deleteBatchJob(id: string): void {
  db.prepare('DELETE FROM batch_jobs WHERE id = ?').run(id)
  db.prepare('DELETE FROM batch_item_evals WHERE job_id = ?').run(id)
  try {
    db.prepare('DELETE FROM batch_item_images WHERE job_id = ?').run(id)
  } catch {
    /* 老库没有这张表时忽略 */
  }
  imageCache.delete(id)
}

/** 评估结果单独存：评估对象带海外同款明细，塞进 items JSON 会把每次进度更新撑大几十倍 */
export function saveItemEvaluation(jobId: string, idx: number, evaluation: unknown): void {
  db.prepare(
    'INSERT INTO batch_item_evals (job_id, idx, evaluation, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(job_id, idx) DO UPDATE SET evaluation=excluded.evaluation, updated_at=excluded.updated_at'
  ).run(jobId, idx, JSON.stringify(evaluation ?? null), new Date().toISOString())
}

export function getItemEvaluation(jobId: string, idx: number): unknown | null {
  const row = db
    .prepare('SELECT evaluation FROM batch_item_evals WHERE job_id = ? AND idx = ?')
    .get(jobId, idx) as unknown as { evaluation: string } | undefined
  return row ? safeJson<unknown>(row.evaluation, null) : null
}

/**
 * 服务重启时，把还挂在 running 的任务标成 interrupted、
 * 把卡在中间步骤的条目标成 error —— 否则前端会一直转圈等一个已经死掉的进程。
 */
export function recoverInterruptedJobs(): number {
  let count = 0
  try {
    const rows = db
      .prepare("SELECT * FROM batch_jobs WHERE status = 'running'")
      .all() as unknown as Row[]
    for (const row of rows) {
      const job = rowToJob(row)
      job.status = 'interrupted'
      job.items = job.items.map((it) =>
        it.status === 'done' || it.status === 'error' || it.status === 'skipped'
          ? it
          : {
              ...it,
              status: 'error',
              stage: '服务重启，这一条被中断',
              error: '任务因服务重启中断，可以点「重试失败项」继续',
            }
      )
      saveBatchJob(job)
      count += 1
    }
  } catch {
    /* 老库没有这张表时忽略 */
  }
  return count
}

/** 生成一条待处理条目（idx 从 1 开始，方便用户对行） */
export function makeBatchItems(rows: ParsedRow[]): BatchItem[] {
  return rows.slice(0, MAX_BATCH_ITEMS).map((r, i) => ({
    idx: i + 1,
    url: r.url,
    input: r.input,
    status: 'pending' as BatchItemStatus,
    stage: '等待抓取',
    title: r.input.title,
  }))
}
