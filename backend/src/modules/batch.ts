/**
 * 批量处理：一次粘贴多条 1688 链接，后台逐条跑「抓取 → 评估 → 入库 → 生成 listing」。
 *
 * 这里**不新增任何业务规则**：每一步调用的都是单品流程用的同一个函数
 * （fetch1688Page / evaluateSource / buildPriceGrid / insertProduct / generateListing），
 * 所以评分口径、印刷方式规则、报价算法、市场探针全部与单品完全一致，只是把点击换成排队。
 *
 * 为什么必须后台跑：单条 30~90 秒，10 条就是 10 分钟，同步 HTTP 早被 Render 的
 * 100 秒代理掐断了。所以 POST 只登记任务并立刻返回，前端轮询进度。
 */

import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { buildPriceGrid } from '../services/pricing'
import { evaluateSource, generateListing } from '../services/workbench'
import { saveSourcingHistory } from './sourcing-history'
import { loadSettings } from './settings'
import {
  BatchItem,
  BatchJob,
  BatchOptions,
  DEFAULT_BATCH_OPTIONS,
  MAX_BATCH_ITEMS,
  createBatchJob,
  deleteBatchJob,
  getBatchJob,
  listBatchJobs,
  makeBatchItems,
  parseBatchInput,
  recoverInterruptedJobs,
  saveBatchJob,
} from '../services/batch-jobs'
import {
  fetch1688Page,
  GrabbedFetched,
  insertProduct,
  runAi,
  sourceSchema,
  toSourceInfo,
} from './products'
import { SourceInfo } from '../types'

export const batchRouter: Router = Router()

/** 正在跑的任务（内存态；DB 里存的是持久状态） */
const running = new Set<string>()
/** 用户点了「停止」的任务 */
const cancelled = new Set<string>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 服务重启后：把上次没跑完的任务标成中断，别让前端一直等
recoverInterruptedJobs()

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 标记当前步骤并落库（前端每次轮询就能看到「正在评估第 3 条」） */
function setStage(job: BatchJob, item: BatchItem, status: BatchItem['status'], stage: string) {
  item.status = status
  item.stage = stage
  item.updatedAt = new Date().toISOString()
  saveBatchJob(job)
}

/** 把抓取结果 + 手填资料合成标准 source（手填优先，抓取补空） */
function buildSource(item: BatchItem, g: GrabbedFetched | null): SourceInfo {
  const carton = (g?.cartonSpecCm ?? '').match(
    /(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)/
  )
  const raw = {
    sourceUrl: item.url,
    // 手填标题优先（抓取失败时也能继续评估）
    sourceTitle: item.input.title || g?.sourceTitle || '',
    sourceKeywords: g?.sourceKeywords ?? [],
    description: item.input.description || g?.description || '',
    materialCn: item.input.materialCn || g?.materialCn || '',
    colorsCn: item.input.colorsCn || g?.colorsCn || '',
    sizeCn: item.input.sizeCn || g?.sizeCn || '',
    weightG: g?.weightG ?? null,
    cartonLCm: carton ? Number(carton[1]) : null,
    cartonWCm: carton ? Number(carton[2]) : null,
    cartonHCm: carton ? Number(carton[3]) : null,
    pcsPerCarton: g?.pcsPerCarton ?? null,
    cartonGwKg: g?.cartonGwKg ?? null,
    moq: item.input.moq ?? g?.moq ?? null,
    priceCny: item.input.priceCny ?? g?.priceCny ?? null,
    // 抓到的首图带上：评估时看图认品类，英文搜索词比纯文本翻译准
    images: g?.image ? [g.image] : [],
  }
  return toSourceInfo(sourceSchema.parse(raw))
}

/** 抓到的有效字段名，前端显示「抓到 5 项」 */
function fetchedFieldNames(g: GrabbedFetched): string[] {
  const out: string[] = []
  if (g.sourceTitle) out.push('标题')
  if (g.description) out.push('描述')
  if (g.materialCn) out.push('材质')
  if (g.colorsCn) out.push('颜色')
  if (g.sizeCn) out.push('尺寸')
  if (g.weightG != null) out.push('单件重')
  if (g.cartonSpecCm) out.push('箱规')
  if (g.pcsPerCarton != null) out.push('每箱数')
  if (g.cartonGwKg != null) out.push('毛重')
  if (g.moq != null) out.push('MOQ')
  if (g.priceCny != null) out.push('价格')
  if (g.image) out.push('主图')
  return out
}

/** 跑一条：抓取 → 评估 → 入库 → listing，任一步失败只标记这一条，不影响后面的 */
async function processItem(job: BatchJob, item: BatchItem, settings: ReturnType<typeof loadSettings>) {
  const opts = job.options
  let fetched: GrabbedFetched | null = null

  // ① 抓取
  if (opts.fetch && item.url) {
    setStage(job, item, 'fetching', '抓取 1688 详情…')
    try {
      const grabbed = await fetch1688Page(item.url)
      fetched = grabbed.fetched
      item.fetchedFields = fetchedFieldNames(grabbed.fetched)
    } catch (err) {
      const msg = errorText(err)
      if (!item.input.title) throw new Error(`抓取失败：${msg}`)
      // 有手填标题就继续：抓取失败不应该让整条白跑
      item.warn = `抓取失败，用你手填的资料继续：${msg}`
    }
  }

  const source = buildSource(item, fetched)
  item.title = source.sourceTitle.trim() || item.input.title || item.url
  if (!source.sourceTitle.trim()) {
    throw new Error('没有商品标题（抓取失败且未手填），无法评估')
  }
  if (opts.evaluate && !source.priceCny) {
    item.warn = [item.warn, '未读到采购单价，成本测算会不准'].filter(Boolean).join('；')
  }
  saveBatchJob(job)

  // ② 评估（与「产品信息预填 → 正式评估」同一个函数、同一套评分口径）
  let evaluation = null as Awaited<ReturnType<typeof evaluateSource>> | null
  let priceGrid: ReturnType<typeof buildPriceGrid>['rows'] = []
  if (opts.evaluate) {
    setStage(job, item, 'evaluating', 'AI 评估中（海外同款 + 评分）…')
    evaluation = await runAi(() => evaluateSource(source, settings, {}))
    priceGrid = buildPriceGrid(source, settings).rows
    item.score = evaluation.score
    item.verdict = evaluation.verdict ?? null
    item.marketNote = (evaluation as { marketNote?: string }).marketNote ?? null
    // 与单品「快速评估」一致：写进历史选品（按链接去重）
    if (item.url) {
      try {
        saveSourcingHistory({
          url: item.url,
          title: source.sourceTitle,
          score: evaluation.score,
          verdict: evaluation.verdict ?? null,
          source,
          fetched: fetched ?? {},
          evaluation,
          priceGrid,
        })
      } catch {
        /* 历史记录失败不影响主流程 */
      }
    }
    saveBatchJob(job)
  }

  // ③ 入库（与单品「保存到产品库」同一段 INSERT）
  if (opts.save || opts.listing) {
    setStage(job, item, 'saving', '写入产品库…')
    item.productId = insertProduct({
      source,
      evaluation,
      listing: null,
      similar: null,
      status: 'sourced',
      draftId: null,
    })
    saveBatchJob(job)
  }

  // ④ 生成英文 listing（与链接生成页同一个函数）
  if (opts.listing && item.productId) {
    setStage(job, item, 'listing', '生成英文 listing…')
    const listing = await runAi(() => generateListing(source, settings, undefined, null))
    db.prepare('UPDATE products SET listing=?, status=?, updated_at=? WHERE id=?').run(
      JSON.stringify(listing),
      'listed',
      new Date().toISOString(),
      item.productId
    )
    saveBatchJob(job)
  }

  item.status = 'done'
  item.stage = opts.listing ? '完成（已入库 + 已生成 listing）' : opts.save ? '完成（已入库）' : '完成'
  item.updatedAt = new Date().toISOString()
  saveBatchJob(job)
}

async function runJob(jobId: string) {
  const job = getBatchJob(jobId)
  if (!job) return
  if (running.has(jobId)) return
  running.add(jobId)
  cancelled.delete(jobId)
  job.status = 'running'
  saveBatchJob(job)

  try {
    const settings = loadSettings()
    // 注意：这里必须始终用同一个 job.items 数组原地改（saveBatchJob 存的就是它）。
    // 之前每次从 DB 重新读一份再 Object.assign 回来，会把数组换成新对象，
    // 结果所有状态改动都写进了被丢弃的旧数组，DB 里永远是 pending。
    for (const item of job.items) {
      if (cancelled.has(jobId)) break
      if (item.status !== 'pending') continue
      try {
        await processItem(job, item, settings)
      } catch (err) {
        item.status = 'error'
        item.stage = '失败'
        item.error = errorText(err)
        item.updatedAt = new Date().toISOString()
        saveBatchJob(job)
      }
      // 每条之间歇一下：AI 供应商有并发/频率限制，排队比并行撞 429 更稳
      await sleep(800)
    }
  } catch (err) {
    job.note = [job.note, `批次中断：${errorText(err)}`].filter(Boolean).join('｜')
  } finally {
    const latest = getBatchJob(jobId)
    if (latest) {
      const pending = latest.items.some((i) => i.status === 'pending')
      latest.status = cancelled.has(jobId) ? 'cancelled' : pending ? 'interrupted' : 'done'
      if (cancelled.has(jobId)) {
        latest.items = latest.items.map((i) =>
          i.status === 'pending' ? { ...i, stage: '已停止（未处理）' } : i
        )
      }
      saveBatchJob(latest)
    }
    running.delete(jobId)
    cancelled.delete(jobId)
  }
}

// ---------------------------------------------------------------- 路由

const optionsSchema = z
  .object({
    fetch: z.boolean().optional(),
    evaluate: z.boolean().optional(),
    save: z.boolean().optional(),
    listing: z.boolean().optional(),
  })
  .optional()

function normalizeOptions(raw: unknown): BatchOptions {
  const o = { ...DEFAULT_BATCH_OPTIONS, ...(raw ?? {}) }
  // 生成 listing 必须入库，否则无处存
  if (o.listing) o.save = true
  // 有链接才谈得上抓取；没有评估的话入库也没意义（但允许，用户可能只想先存着）
  return o
}

/** 解析预览：把粘贴的文本切成条目，先给用户看一眼再开跑 */
batchRouter.post('/parse', (req: Request, res: Response) => {
  const text = String((req.body as { text?: unknown })?.text ?? '')
  const parsed = parseBatchInput(text)
  res.json({
    ok: true,
    rows: parsed.rows,
    issues: parsed.issues,
    duplicates: parsed.duplicates,
    manualCount: parsed.manualCount,
    maxItems: MAX_BATCH_ITEMS,
    willProcess: Math.min(parsed.rows.length, MAX_BATCH_ITEMS),
  })
})

/** 创建任务：登记完立刻返回，后台开始跑 */
batchRouter.post('/jobs', (req: Request, res: Response) => {
  const body = z
    .object({
      text: z.string().max(400_000).optional(),
      options: optionsSchema,
    })
    .parse(req.body ?? {})

  const parsed = parseBatchInput(body.text ?? '')
  if (parsed.rows.length === 0) {
    throw new AppError(400, '没识别出任何产品：每行一个 1688 链接，或用 Tab 分隔「链接 / 标题 / 价格」')
  }
  const options = normalizeOptions(body.options)
  if (!options.fetch && !options.evaluate && !options.save && !options.listing) {
    throw new AppError(400, '至少要选一个处理步骤（抓取 / 评估 / 入库 / 生成 listing）')
  }
  // 有链接才能抓：整批都没链接时自动关掉抓取，避免每条都报错
  const hasUrl = parsed.rows.some((r) => r.url)
  if (!hasUrl) options.fetch = false

  const items = makeBatchItems(parsed.rows)
  const note = [
    `${items.length} 条`,
    options.fetch && '抓取',
    options.evaluate && '评估',
    options.save && '入库',
    options.listing && 'listing',
  ]
    .filter(Boolean)
    .join(' + ')

  const job = createBatchJob(options, items, note)
  // 后台跑，不阻塞响应
  void runJob(job.id)

  const truncated = parsed.rows.length > MAX_BATCH_ITEMS
  res.status(201).json({
    ok: true,
    job: getBatchJob(job.id) ?? job,
    skipped: parsed.issues.length + parsed.duplicates.length,
    truncated,
  })
})

/** 任务列表（最近 10 个） */
batchRouter.get('/jobs', (_req: Request, res: Response) => {
  const jobs = listBatchJobs(10).map((j) => ({
    id: j.id,
    status: j.status,
    note: j.note,
    total: j.items.length,
    done: j.items.filter((i) => i.status === 'done').length,
    failed: j.items.filter((i) => i.status === 'error').length,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  }))
  const activeJobId = jobs.find((j) => j.status === 'running')?.id ?? null
  res.json({ jobs, activeJobId })
})

/** 任务详情：前端每 2.5 秒轮询一次 */
batchRouter.get('/jobs/:id', (req: Request, res: Response) => {
  const job = getBatchJob(String(req.params.id))
  if (!job) throw new AppError(404, '任务不存在或已删除')
  res.json({ job })
})

/** 停止：当前这条跑完就停，剩下一律不跑（已入库的不回滚） */
batchRouter.post('/jobs/:id/cancel', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const job = getBatchJob(id)
  if (!job) throw new AppError(404, '任务不存在')
  if (!running.has(id)) {
    job.status = job.status === 'done' ? 'done' : 'cancelled'
    saveBatchJob(job)
    res.json({ ok: true, job })
    return
  }
  cancelled.add(id)
  res.json({ ok: true, job: getBatchJob(id) ?? job })
})

/** 重试失败项：只把 error 的条目重置成待处理，成功的保持不动 */
batchRouter.post('/jobs/:id/retry', (req: Request, res: Response) => {
  const id = String(req.params.id)
  if (running.has(id)) throw new AppError(409, '这一批还在跑，等它跑完再重试失败的')
  const job = getBatchJob(id)
  if (!job) throw new AppError(404, '任务不存在')

  let reset = 0
  job.items = job.items.map((it) => {
    if (it.status !== 'error' && it.status !== 'skipped') return it
    reset += 1
    return { ...it, status: 'pending' as const, stage: '等待重试', error: undefined }
  })
  if (reset === 0) throw new AppError(400, '没有失败的条目需要重试')
  job.status = 'pending'
  saveBatchJob(job)
  void runJob(job.id)
  res.json({ ok: true, job: getBatchJob(job.id) ?? job, reset })
})

batchRouter.delete('/jobs/:id', (req: Request, res: Response) => {
  const id = String(req.params.id)
  if (running.has(id)) throw new AppError(409, '任务运行中，先停止再删除')
  deleteBatchJob(id)
  res.json({ ok: true })
})
