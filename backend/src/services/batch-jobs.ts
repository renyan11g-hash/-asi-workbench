/**
 * 批量处理任务：数据模型 + 粘贴文本解析 + 落库读写。
 *
 * 设计原则：这里只管「一坨文本怎么变成 N 条待处理产品」和「任务状态怎么存」，
 * 具体怎么跑（抓取/评估/入库/listing）全部复用单品流程的同一批函数，见 modules/batch.ts。
 * 单品规则的任何参数都不在这里改。
 */

import { db } from '../db'

/** 单条产品的处理阶段（前端按这个显示 badge） */
export type BatchItemStatus =
  | 'pending'
  | 'fetching'
  | 'evaluating'
  | 'saving'
  | 'listing'
  | 'done'
  | 'error'
  | 'skipped'

export type BatchJobStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'cancelled'
  | 'interrupted'

/** 手填资料：全部可选，填了就覆盖 1688 抓取到的同名字段 */
export interface BatchItemInput {
  title?: string
  priceCny?: number | null
  moq?: number | null
  sizeCn?: string
  materialCn?: string
  colorsCn?: string
  description?: string
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

// ---------------------------------------------------------------- 解析

/** 表头别名：中英文都认，按顺序匹配 */
const COLUMN_ALIASES: Record<keyof BatchItemInput | 'url', RegExp[]> = {
  url: [/^url$/i, /链接/, /^link$/i, /地址/],
  title: [/标题/, /品名/, /^title$/i, /名称/, /product/i],
  priceCny: [/采购价/, /单价/, /价格/, /^price$/i, /进货价/],
  moq: [/^moq$/i, /起订/, /起批/],
  sizeCn: [/尺寸/, /^size$/i, /规格/],
  materialCn: [/材质/, /^material$/i],
  colorsCn: [/颜色/, /^colou?r/i],
  description: [/描述/, /卖点/, /^description$/i, /详情/, /备注/, /^remark/i],
}

const URL_RE = /https?:\/\/[^\s|,，、]+/i

function splitCells(line: string): string[] {
  // Tab 优先（从 Excel 直接粘贴就是 Tab），其次竖线；逗号不切：标题里常带逗号
  if (line.includes('\t')) return line.split('\t')
  if (line.includes('|')) return line.split('|')
  return [line]
}

function detectHeader(cells: string[]): (keyof BatchItemInput | 'url')[] | null {
  if (cells.length < 2) return null
  const keys = cells.map((c) => {
    const t = c.trim()
    if (!t) return null
    for (const [key, res] of Object.entries(COLUMN_ALIASES) as Array<
      [keyof BatchItemInput | 'url', RegExp[]]
    >) {
      if (res.some((re) => re.test(t))) return key
    }
    return null
  })
  const hit = keys.filter(Boolean).length
  if (hit < 2) return null
  return keys as (keyof BatchItemInput | 'url')[]
}

/** 固定列序（无表头时按这个位置取） */
const POSITIONAL: Array<keyof BatchItemInput | 'url'> = [
  'url',
  'title',
  'priceCny',
  'moq',
  'sizeCn',
  'materialCn',
  'colorsCn',
  'description',
]

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
 *   https://detail.1688.com/offer/123.html	收纳盒	3.5	100	20x15x8cm	PU皮
 *   收纳盒	3.5	100            ← 没有链接也行，纯手动录入
 * 第一行如果是表头（含「链接/标题/价格」等），按表头映射列，否则按固定列序。
 */
export function parseBatchInput(raw: string): ParseResult {
  const rows: ParsedRow[] = []
  const issues: ParseIssue[] = []
  const duplicates: string[] = []
  const seen = new Set<string>()
  let mapping: (keyof BatchItemInput | 'url')[] | null = null
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

    const keyed: Partial<Record<keyof BatchItemInput | 'url', string>> = {}
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

    rows.push({
      url,
      input: {
        title: title || undefined,
        priceCny: num(keyed.priceCny),
        moq: num(keyed.moq),
        sizeCn: text(keyed.sizeCn) || undefined,
        materialCn: text(keyed.materialCn) || undefined,
        colorsCn: text(keyed.colorsCn) || undefined,
        description: text(keyed.description) || undefined,
      },
    })
  })

  return { rows, issues, duplicates, manualCount }
}

// ---------------------------------------------------------------- 落库

interface Row {
  id: string
  status: string
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
    options: { ...DEFAULT_BATCH_OPTIONS, ...safeJson<Partial<BatchOptions>>(r.options, {}) },
    items: safeJson<BatchItem[]>(r.items, []),
    note: r.note ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function createBatchJob(options: BatchOptions, items: BatchItem[], note = ''): BatchJob {
  const id = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO batch_jobs (id, status, options, items, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'pending', JSON.stringify(options), JSON.stringify(items), note, now, now)
  return {
    id,
    status: 'pending',
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
  db.prepare('UPDATE batch_jobs SET status=?, options=?, items=?, note=?, updated_at=? WHERE id=?').run(
    job.status,
    JSON.stringify(job.options),
    JSON.stringify(job.items),
    job.note,
    now,
    job.id
  )
}

export function getBatchJob(id: string): BatchJob | null {
  const row = db.prepare('SELECT * FROM batch_jobs WHERE id = ?').get(id) as unknown as Row | undefined
  return row ? rowToJob(row) : null
}

export function listBatchJobs(limit = 10): BatchJob[] {
  const rows = db
    .prepare('SELECT * FROM batch_jobs ORDER BY created_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(50, limit))) as unknown as Row[]
  return rows.map(rowToJob)
}

export function deleteBatchJob(id: string): void {
  db.prepare('DELETE FROM batch_jobs WHERE id = ?').run(id)
}

/**
 * 服务重启时，把还挂在 running/pending 的任务标成 interrupted、
 * 把卡在中间步骤的条目标成 error —— 否则前端会一直转圈等一个已经死掉的进程。
 */
export function recoverInterruptedJobs(): number {
  let count = 0
  try {
    const rows = db
      .prepare("SELECT * FROM batch_jobs WHERE status IN ('pending','running')")
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
              error: '任务因服务重启中断，可点「重试失败项」继续',
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
    stage: '等待处理',
    title: r.input.title,
  }))
}
