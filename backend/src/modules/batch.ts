/**
 * 批量处理：一次粘贴多条 1688 链接，按单品页的顺序分阶段跑
 *   ① 抓取 1688 资料 → ② **人工补全箱规等抓不到的字段** → ③ AI 评估 → ④ 入库（可选生成 listing）
 *
 * 「②补全」不是可选步骤：1688 页面基本拿不到箱规/每箱数/箱毛重，缺了这些
 * 运费和报价只能按默认值估算，分数会骗人。所以批量必须像单品页一样停下来让人填，
 * 而不是抓完就直接评估。
 *
 * 这里**不新增任何业务规则**：每一步调用的都是单品流程用的同一个函数
 * （fetch1688Page / evaluateSource / buildPriceGrid / insertProduct / generateListing），
 * 所以评分口径、印刷方式规则、报价算法、市场探针全部与单品完全一致，只是把点击换成排队。
 */

import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { buildPriceGrid } from '../services/pricing'
import { evaluateSource, generateListing } from '../services/workbench'
import { saveSourcingHistory } from './sourcing-history'
import { loadSettings } from './settings'
import {
  BatchItem,
  BatchItemInput,
  BatchJob,
  BatchOptions,
  BatchPhase,
  DEFAULT_BATCH_OPTIONS,
  MAX_BATCH_ITEMS,
  canEvaluate,
  createBatchJob,
  deleteBatchJob,
  getBatchJob,
  getItemEvaluation,
  listBatchJobs,
  makeBatchItems,
  missingFields,
  parseBatchInput,
  recoverInterruptedJobs,
  saveBatchJob,
  saveItemEvaluation,
} from '../services/batch-jobs'
import {
  fetch1688Page,
  GrabbedFetched,
  insertProduct,
  runAi,
  sourceSchema,
  toSourceInfo,
} from './products'
import { Evaluation, SourceInfo } from '../types'

export const batchRouter: Router = Router()

/** 正在跑的任务（内存态；DB 里存的是持久状态） */
const running = new Set<string>()
/** 用户点了「停止」的任务 */
const cancelled = new Set<string>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Stage = 'fetch' | 'evaluate' | 'save' | 'all'

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

/** 1688 失效/下架页面的标题特征（抓到这种页面不算抓取成功） */
function isDeadOfferTitle(title: string): boolean {
  const t = (title ?? '').trim()
  if (!t) return false
  return /无法查看|已下架|不存在|已被删除|该商品.{0,4}下架|访问的页面/.test(t)
}

const CARTON_RE = /(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)/

/** 抓取结果 → SourceInfo（还没叠加手填） */
function baseFromGrabbed(g: GrabbedFetched, url: string): SourceInfo {
  const carton = (g.cartonSpecCm ?? '').match(CARTON_RE)
  return {
    sourceTitle: g.sourceTitle,
    sourceUrl: url,
    description: g.description,
    sourceKeywords: g.sourceKeywords ?? [],
    amazonTitle: '',
    priceCny: g.priceCny ?? 0,
    priceMaxCny: null,
    moq: g.moq ?? 0,
    supplier: '',
    materialCn: g.materialCn,
    colorsCn: g.colorsCn,
    sizeCn: g.sizeCn,
    weightG: g.weightG,
    cartonLCm: carton ? Number(carton[1]) : null,
    cartonWCm: carton ? Number(carton[2]) : null,
    cartonHCm: carton ? Number(carton[3]) : null,
    pcsPerCarton: g.pcsPerCarton,
    cartonGwKg: g.cartonGwKg,
    // 抓到的产品图带上（多张）：评估认品类、后面出图当参考图都用它
    images: g.images?.length ? g.images : g.image ? [g.image] : [],
    category: '',
    notes: '',
  }
}

function emptySource(url: string): SourceInfo {
  return {
    sourceTitle: '',
    sourceUrl: url,
    description: '',
    sourceKeywords: [],
    amazonTitle: '',
    priceCny: 0,
    priceMaxCny: null,
    moq: 0,
    supplier: '',
    materialCn: '',
    colorsCn: '',
    sizeCn: '',
    weightG: null,
    cartonLCm: null,
    cartonWCm: null,
    cartonHCm: null,
    pcsPerCarton: null,
    cartonGwKg: null,
    images: [],
    category: '',
    notes: '',
  }
}

/**
 * 合并三层数据：抓取结果 < 之前存下的 source < 用户手填的 input。
 * 手填优先（这才是「预填」的意义）；只认真正填过的键，留空不会把抓取到的值抹掉。
 */
function mergeSource(item: BatchItem, grabbed: GrabbedFetched | null): SourceInfo {
  const seed = grabbed ? baseFromGrabbed(grabbed, item.url) : item.source ?? emptySource(item.url)
  const i = item.input
  const has = <K extends keyof BatchItemInput>(k: K) => Object.prototype.hasOwnProperty.call(i, k)
  const merged: SourceInfo = {
    ...seed,
    sourceUrl: item.url || seed.sourceUrl,
    sourceTitle: has('title') ? (i.title ?? '') : seed.sourceTitle,
    description: has('description') ? (i.description ?? '') : seed.description,
    materialCn: has('materialCn') ? (i.materialCn ?? '') : seed.materialCn,
    colorsCn: has('colorsCn') ? (i.colorsCn ?? '') : seed.colorsCn,
    sizeCn: has('sizeCn') ? (i.sizeCn ?? '') : seed.sizeCn,
    priceCny: has('priceCny') ? (i.priceCny ?? 0) : seed.priceCny,
    moq: has('moq') ? (i.moq ?? 0) : seed.moq,
    weightG: has('weightG') ? (i.weightG ?? null) : seed.weightG,
    cartonLCm: has('cartonLCm') ? (i.cartonLCm ?? null) : seed.cartonLCm,
    cartonWCm: has('cartonWCm') ? (i.cartonWCm ?? null) : seed.cartonWCm,
    cartonHCm: has('cartonHCm') ? (i.cartonHCm ?? null) : seed.cartonHCm,
    pcsPerCarton: has('pcsPerCarton') ? (i.pcsPerCarton ?? null) : seed.pcsPerCarton,
    cartonGwKg: has('cartonGwKg') ? (i.cartonGwKg ?? null) : seed.cartonGwKg,
    // 手填/抓取的图片：填了就用手填的（补全时加图），否则沿用抓到的
    images: has('images') ? (i.images ?? []) : seed.images,
  }
  // 走一遍单品用的 schema，保证类型/默认值与单品完全一致
  return toSourceInfo(sourceSchema.parse(merged))
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

/** ① 抓取一条：只抓取、不评估，抓完停下来等你补全 */
async function fetchItem(job: BatchJob, item: BatchItem) {
  setStage(job, item, 'fetching', '抓取 1688 详情…')
  let fetched: GrabbedFetched | null = null
  let failure = ''
  try {
    const grabbed = await fetch1688Page(item.url)
    // 1688 对失效/下架链接不报错，而是返回「商品无法查看或已下架」页面。
    // 不拦的话会拿这个当商品标题入库，10 条死链就是 10 个垃圾产品。
    if (isDeadOfferTitle(grabbed.fetched.sourceTitle)) {
      throw new Error('1688 返回「商品无法查看或已下架」，链接可能失效')
    }
    fetched = grabbed.fetched
    item.fetchedFields = fetchedFieldNames(grabbed.fetched)
  } catch (err) {
    failure = errorText(err)
  }

  const source = mergeSource(item, fetched)
  item.source = source
  item.title = source.sourceTitle.trim() || item.input.title || item.url
  item.missing = missingFields(source)

  if (failure) {
    // 抓取失败但有手填标题：继续走补全/评估，不要让整条白费
    if (!source.sourceTitle.trim()) {
      item.status = 'error'
      item.stage = '抓取失败'
      item.error = `抓取失败：${failure}（可手填标题和资料后重试，或直接删掉这条）`
      item.updatedAt = new Date().toISOString()
      saveBatchJob(job)
      return
    }
    item.warn = `抓取失败，用你手填的资料继续：${failure}`
  } else {
    item.warn = undefined
  }

  item.status = 'fetched'
  item.stage = item.missing.length
    ? `已抓取，缺 ${item.missing.length} 项（${item.missing.join('/')}）待补全`
    : '已抓取，资料齐全'
  item.updatedAt = new Date().toISOString()
  saveBatchJob(job)
}

/** ③ 评估一条（不落库，结果单独存表，等第 ④ 步入库） */
async function evaluateItem(job: BatchJob, item: BatchItem, settings: ReturnType<typeof loadSettings>) {
  const source = mergeSource(item, null)
  item.source = source
  item.missing = missingFields(source)
  if (!source.sourceTitle.trim()) {
    item.status = 'error'
    item.stage = '缺少商品标题'
    item.error = '没有商品标题，无法评估（抓取失败且未手填）'
    saveBatchJob(job)
    return
  }

  setStage(job, item, 'evaluating', 'AI 评估中（海外同款 + 评分 + 报价）…')
  const evaluation = await runAi(() => evaluateSource(source, settings, {}))
  const priceGrid = buildPriceGrid(source, settings).rows

  item.score = evaluation.score
  item.verdict = evaluation.verdict ?? null
  item.marketNote = (evaluation as { marketNote?: string }).marketNote ?? null
  item.evaluated = true
  item.status = 'evaluated'
  item.stage = item.missing.length
    ? `已评估（注意：缺 ${item.missing.join('/')}，费率按默认值算）`
    : '已评估，待入库'
  item.updatedAt = new Date().toISOString()
  saveItemEvaluation(job.id, item.idx, evaluation)
  if (item.url) {
    try {
      saveSourcingHistory({
        url: item.url,
        title: source.sourceTitle,
        score: evaluation.score,
        verdict: evaluation.verdict ?? null,
        source,
        fetched: {},
        evaluation,
        priceGrid,
      })
    } catch {
      /* 历史记录失败不影响主流程 */
    }
  }
  saveBatchJob(job)
}

/** ④ 入库一条（用第 ③ 步存下的评估结果；可选再生成 listing） */
async function saveItem(job: BatchJob, item: BatchItem, settings: ReturnType<typeof loadSettings>) {
  const source = item.source ?? mergeSource(item, null)
  const evaluation = getItemEvaluation(job.id, item.idx) as Evaluation | null
  if (!evaluation) {
    item.status = 'error'
    item.stage = '缺少评估结果'
    item.error = '这条没有评估结果（可能评估失败），请重新评估后再入库'
    saveBatchJob(job)
    return
  }

  setStage(job, item, 'saving', '写入产品库 + 评估库…')
  // 评估库（云端草稿）也留一份：单品流程是「评估 → 存评估库 → 保存到产品库」，
  // 批量同样两条都写，否则评估库是空的、想回头看评分明细就没有入口。
  const priceGrid = buildPriceGrid(source, settings).rows
  const draftId = randomUUID()
  const draftNow = new Date().toISOString()
  db.prepare('INSERT INTO drafts (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    draftId,
    (source.sourceTitle || `批量产品 ${item.idx}`).slice(0, 60),
    JSON.stringify({
      kind: 'sourcing-evaluation',
      source,
      evaluation,
      priceGrid,
      keywordsText: (source.sourceKeywords ?? []).join('\n'),
      imageText: (source.images ?? []).filter((u) => u.startsWith('http')).join('\n'),
      similar: null,
    }),
    draftNow,
    draftNow
  )

  const productId = insertProduct({
    source,
    evaluation,
    listing: null,
    similar: null,
    status: 'sourced',
    draftId,
  })
  item.productId = productId
  saveBatchJob(job)

  if (job.options.listing) {
    setStage(job, item, 'listing', '生成英文 listing…')
    const listing = await runAi(() => generateListing(source, settings, undefined, null))
    db.prepare('UPDATE products SET listing=?, status=?, updated_at=? WHERE id=?').run(
      JSON.stringify(listing),
      'listed',
      new Date().toISOString(),
      productId
    )
  }

  item.status = 'done'
  item.stage = job.options.listing ? '完成（已入库 + 已生成 listing）' : '完成（已入库）'
  item.updatedAt = new Date().toISOString()
  saveBatchJob(job)
}

/** 根据条目状态推断整批走到哪一站（按「还没失败的那批条目」整体判断，混合状态才不会误报） */
function computePhase(job: BatchJob): BatchPhase {
  const live = job.items.filter((i) => i.status !== 'error' && i.status !== 'skipped')
  if (!live.length) return 'draft'
  if (live.every((i) => i.productId)) return 'saved'
  if (live.every((i) => i.evaluated)) return 'evaluated'
  if (live.every((i) => i.source)) return 'fetched'
  return 'draft'
}

/** 抓取只针对「还没有资料」的条目，避免每次点抓取都把已抓过的重抓一遍 */
function fetchTargets(item: BatchItem): boolean {
  return Boolean(item.url) && !item.source && !item.productId
}

function evaluateTargets(item: BatchItem): boolean {
  return canEvaluate(item) && !item.productId && !item.evaluated
}

function saveTargets(item: BatchItem): boolean {
  return Boolean(item.evaluated) && !item.productId
}

/** 跑指定阶段：逐条串行，任何一条失败只标记这一条 */
async function runStage(jobId: string, stage: Stage, idxs: number[] | null) {
  const job = getBatchJob(jobId)
  if (!job) return
  if (running.has(jobId)) return
  running.add(jobId)
  cancelled.delete(jobId)
  job.status = 'running'
  saveBatchJob(job)
  const settings = loadSettings()
  const picked = (item: BatchItem) => !idxs || idxs.includes(item.idx)

  const step = async (fn: () => Promise<void>, item: BatchItem, gap: number) => {
    try {
      await fn()
    } catch (err) {
      item.status = 'error'
      item.stage = '失败'
      item.error = errorText(err)
      item.updatedAt = new Date().toISOString()
      saveBatchJob(job)
    }
    await sleep(gap)
  }

  try {
    if (stage === 'fetch' || stage === 'all') {
      for (const item of job.items) {
        if (cancelled.has(jobId)) break
        if (!picked(item) || !fetchTargets(item)) continue
        await step(() => fetchItem(job, item), item, 500)
      }
    }
    if (stage === 'evaluate' || stage === 'all') {
      for (const item of job.items) {
        if (cancelled.has(jobId)) break
        if (!picked(item) || !evaluateTargets(item)) continue
        // 没抓过资料的（纯手填），先合并一次 source，保证评估用的是手填值
        if (!item.evaluated) await step(() => evaluateItem(job, item, settings), item, 700)
      }
    }
    if (stage === 'save' || stage === 'all') {
      for (const item of job.items) {
        if (cancelled.has(jobId)) break
        if (!picked(item) || !saveTargets(item)) continue
        await step(() => saveItem(job, item, settings), item, 400)
      }
    }
  } finally {
    job.phase = computePhase(job)
    job.status = cancelled.has(jobId) ? 'cancelled' : 'done'
    if (cancelled.has(jobId)) {
      job.items = job.items.map((i) =>
        ['fetching', 'evaluating', 'saving', 'listing'].includes(i.status)
          ? { ...i, status: 'pending', stage: '已停止' }
          : i
      )
    }
    saveBatchJob(job)
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

/** 创建任务：只建草稿，不自动跑（先抓取 → 人工补全 → 再评估） */
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
  const items = makeBatchItems(parsed.rows)
  const note = `${items.length} 条${options.listing ? ' + 生成 listing' : ''}`
  const job = createBatchJob(options, items, note)

  res.status(201).json({
    ok: true,
    job: getBatchJob(job.id) ?? job,
    skipped: parsed.issues.length + parsed.duplicates.length,
    truncated: parsed.rows.length > MAX_BATCH_ITEMS,
  })
})

/** 任务列表（最近 10 个） */
batchRouter.get('/jobs', (_req: Request, res: Response) => {
  const jobs = listBatchJobs(10).map((j) => ({
    id: j.id,
    status: j.status,
    // 老批次的 phase 可能是空的：按条目现算，列表才不会显示错阶段
    phase: computePhase(j),
    note: j.note,
    total: j.items.length,
    fetched: j.items.filter((i) => Boolean(i.source)).length,
    evaluated: j.items.filter((i) => i.evaluated).length,
    done: j.items.filter((i) => Boolean(i.productId)).length,
    failed: j.items.filter((i) => i.status === 'error').length,
    missing: j.items.filter((i) => (i.missing?.length ?? 0) > 0).length,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  }))
  const activeJobId = jobs.find((j) => j.status === 'running')?.id ?? null
  res.json({ jobs, activeJobId })
})

/** 任务详情：前端轮询 */
batchRouter.get('/jobs/:id', (req: Request, res: Response) => {
  const job = getBatchJob(String(req.params.id))
  if (!job) throw new AppError(404, '任务不存在或已删除')
  // 老批次（拆分阶段之前建的）phase 是空的，读的时候按条目重算一次，避免显示错阶段
  job.phase = computePhase(job)
  res.json({ job })
})

/**
 * 跑阶段：
 *   fetch    只抓取（抓完停下，等人补箱规）
 *   evaluate 批量评估（不落库）
 *   save     入库（+ 可选 listing）
 *   all      一口气跑完（跳过人工补全，字段缺就按默认值算）
 */
batchRouter.post('/jobs/:id/run', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const job = getBatchJob(id)
  if (!job) throw new AppError(404, '任务不存在')
  if (running.has(id)) throw new AppError(409, '这一批还在跑，等它跑完再点')

  const body = z
    .object({
      stage: z.enum(['fetch', 'evaluate', 'save', 'all']).default('all'),
      idxs: z.array(z.number().int().positive()).max(MAX_BATCH_ITEMS).optional(),
    })
    .parse(req.body ?? {})

  const idxs = body.idxs && body.idxs.length ? body.idxs : null
  const candidates = job.items.filter((it) => (idxs ? idxs.includes(it.idx) : true))
  const eligible =
    body.stage === 'fetch' || body.stage === 'all'
      ? candidates.some(fetchTargets)
      : body.stage === 'evaluate'
        ? candidates.some(evaluateTargets)
        : candidates.some(saveTargets)

  if (!eligible) {
    const msg =
      body.stage === 'fetch'
        ? '没有需要抓取的条目（都抓过了，或没有链接）'
        : body.stage === 'evaluate'
          ? '没有可评估的条目（缺标题，或已评估/已入库）'
          : '没有可入库的条目（还没评估，或已入库）'
    throw new AppError(400, msg)
  }

  job.status = 'running'
  saveBatchJob(job)
  void runStage(id, body.stage, idxs)
  res.json({ ok: true, job: getBatchJob(id) ?? job })
})

/** 改一条的资料（补全箱规/每箱数/毛重这些 1688 抓不到的字段） */
batchRouter.patch('/jobs/:id/items/:idx', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const idx = Number(req.params.idx)
  if (running.has(id)) throw new AppError(409, '这一批还在跑，等它跑完再改')
  const job = getBatchJob(id)
  if (!job) throw new AppError(404, '任务不存在')
  const item = job.items.find((i) => i.idx === idx)
  if (!item) throw new AppError(404, `第 ${idx} 条不存在`)
  // 已入库的不要再改：这条产品已经在产品库里了，改这里只会让两边不一致
  if (item.productId) {
    throw new AppError(409, `第 ${idx} 条已经入库，请到产品库 / 链接生成页去改`)
  }

  const body = z
    .object({
      input: z.object({
        title: z.string().max(500).optional(),
        priceCny: z.number().nullable().optional(),
        moq: z.number().nullable().optional(),
        sizeCn: z.string().max(200).optional(),
        materialCn: z.string().max(200).optional(),
        colorsCn: z.string().max(200).optional(),
        description: z.string().max(5000).optional(),
        images: z.array(z.string().max(4000)).max(12).optional(),
        weightG: z.number().nullable().optional(),
        cartonLCm: z.number().nullable().optional(),
        cartonWCm: z.number().nullable().optional(),
        cartonHCm: z.number().nullable().optional(),
        pcsPerCarton: z.number().nullable().optional(),
        cartonGwKg: z.number().nullable().optional(),
      }),
    })
    .parse(req.body ?? {})

  item.input = { ...item.input, ...body.input }
  item.source = mergeSource(item, null)
  item.title = item.source.sourceTitle.trim() || item.url
  item.missing = missingFields(item.source)

  // 改了资料，之前的评估就作废了 —— 必须重新评估，否则入库的还是旧分数
  if (item.evaluated) {
    item.evaluated = false
    item.score = null
    item.verdict = null
    item.marketNote = null
    item.status = 'fetched'
    item.stage = '资料已改，需重新评估'
  } else if (item.status !== 'error') {
    item.status = 'fetched'
    item.stage = item.missing.length
      ? `缺 ${item.missing.length} 项（${item.missing.join('/')}）`
      : '资料齐全，可以评估'
  }
  item.updatedAt = new Date().toISOString()
  job.phase = computePhase(job)
  saveBatchJob(job)
  res.json({ ok: true, job })
})

/** 删除条目（勾选后批量删）：已入库的不动，避免产品库里出现「孤儿」 */
batchRouter.post('/jobs/:id/items/delete', (req: Request, res: Response) => {
  const id = String(req.params.id)
  if (running.has(id)) throw new AppError(409, '这一批还在跑，等它跑完再删')
  const job = getBatchJob(id)
  if (!job) throw new AppError(404, '任务不存在')
  const body = z.object({ idxs: z.array(z.number().int().positive()).min(1).max(MAX_BATCH_ITEMS) }).parse(req.body ?? {})
  const wanted = new Set(body.idxs)

  let removed = 0
  let skipped = 0
  job.items = job.items.filter((it) => {
    if (!wanted.has(it.idx)) return true
    if (it.productId) {
      skipped += 1
      return true
    }
    removed += 1
    return false
  })
  if (removed === 0 && skipped === 0) throw new AppError(400, '没有匹配的条目')
  job.phase = computePhase(job)
  saveBatchJob(job)
  res.json({ ok: true, job, removed, skipped })
})

/** 停止：当前这条跑完就停，剩下一律不跑（已入库的不回滚） */batchRouter.post('/jobs/:id/cancel', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const job = getBatchJob(id)
  if (!job) throw new AppError(404, '任务不存在')
  if (!running.has(id)) {
    job.status = 'cancelled'
    job.phase = computePhase(job)
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
    const next: BatchItem = {
      ...it,
      error: undefined,
      status: it.source ? 'fetched' : 'pending',
      stage: it.source ? '待重新评估' : '等待抓取',
    }
    return next
  })
  if (reset === 0) throw new AppError(400, '没有失败的条目需要重试')
  job.status = 'draft'
  job.phase = computePhase(job)
  saveBatchJob(job)
  res.json({ ok: true, job, reset })
})

batchRouter.delete('/jobs/:id', (req: Request, res: Response) => {
  const id = String(req.params.id)
  if (running.has(id)) throw new AppError(409, '任务运行中，先停止再删除')
  deleteBatchJob(id)
  res.json({ ok: true })
})
