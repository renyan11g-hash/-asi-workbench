/**
 * 批量处理：一次粘贴多条 1688 链接，按单品页的顺序分阶段跑
 *   ① 信息预填（抓取 1688 / 命中资料库） → ② **人工补全箱规等抓不到的字段**
 *   → ③ 选品预估（缺字段也能先粗评一版） → ④ AI 评估 → ⑤ 生成英文链接（进待审核库）→ ⑥ 审核通过后入产品库
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
import { createListingReview, dropPendingReview, getListingReview } from './listing-reviews'
import { inlineImages } from '../services/image-inline'
import {
  BatchItem,
  BatchItemInput,
  BatchJob,
  BatchOptions,
  BatchPhase,
  BatchStage,
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
/**
 * 用户点了「暂停 / 停止」：正在跑的这一条跑完就停。
 * 暂停 = 保留进度、可以接着跑；停止 = 这一轮结束（条目不会丢，随时能再点阶段按钮）。
 */
const stopRequests = new Map<string, 'pause' | 'stop'>()

const STOP = {
  pause: '已暂停（点「继续」接着跑）',
  stop: '已停止',
} as const


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
  // 1688 的图有防盗链：浏览器直接引用会显示成破损图片。
  // 所以抓到之后立刻在服务端下载并转成 data URL，抓不到的丢掉并提示。
  let imgDropped = 0
  if ((source.images ?? []).some((u) => /^https?:/i.test(u))) {
    const inlined = await inlineImages(source.images)
    source.images = inlined.images
    imgDropped = inlined.dropped
  }
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
    item.warn = imgDropped ? `有 ${imgDropped} 张产品图下载失败，请手动上传` : undefined
  }

  item.status = 'fetched'
  item.stage = item.missing.length
    ? `已抓取，缺 ${item.missing.length} 项（${item.missing.join('/')}）待补全`
    : '已抓取，资料齐全'
  item.updatedAt = new Date().toISOString()
  saveBatchJob(job)
}

/**
 * 把评估结果写进「评估库」（drafts 表）—— 和单品页一样：
 * 评估完先有一条草稿，入库产品时再复用这条，避免重复造草稿。
 */
function upsertEvaluationDraft(
  item: BatchItem,
  source: SourceInfo,
  evaluation: Evaluation,
  priceGrid: ReturnType<typeof buildPriceGrid>['rows']
): string {
  const now = new Date().toISOString()
  const title = (source.sourceTitle || `批量产品 ${item.idx}`).slice(0, 60)
  const content = JSON.stringify({
    kind: 'sourcing-evaluation',
    source,
    evaluation,
    priceGrid,
    keywordsText: (source.sourceKeywords ?? []).join('\n'),
    imageText: (source.images ?? []).filter((u) => u.startsWith('http')).join('\n'),
    similar: null,
  })
  if (item.draftId) {
    const exists = db.prepare('SELECT id FROM drafts WHERE id = ?').get(item.draftId)
    if (exists) {
      db.prepare('UPDATE drafts SET title=?, content=?, updated_at=? WHERE id=?').run(
        title,
        content,
        now,
        item.draftId
      )
      return item.draftId
    }
  }
  const id = randomUUID()
  db.prepare('INSERT INTO drafts (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    title,
    content,
    now,
    now
  )
  return id
}

/**
 * ③ 评估一条（不落库到产品库，但会写一条「评估库」草稿）
 *
 * mode = 'quick' 是「选品预估」：字段不全也能先粗评一版（缺箱规按默认值估运费），
 * 结果不标记为已评估，所以正式评估会重新跑一遍并覆盖。
 */
async function evaluateItem(
  job: BatchJob,
  item: BatchItem,
  settings: ReturnType<typeof loadSettings>,
  mode: 'quick' | 'full' = 'full'
) {
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
  if ((source.images ?? []).some((u) => /^https?:/i.test(u))) {
    // 评估会把这些图喂给 AI 看图：外链在这里也要先内联，否则 AI 拿到的是防盗链页面
    const inlined = await inlineImages(source.images)
    source.images = inlined.images
    item.source = source
  }

  setStage(
    job,
    item,
    'evaluating',
    mode === 'quick' ? '选品预估中（缺字段按默认值估算）…' : 'AI 评估中（海外同款 + 评分 + 报价）…'
  )
  const evaluation = await runAi(() => evaluateSource(source, settings, {}))
  const priceGrid = buildPriceGrid(source, settings).rows

  item.score = evaluation.score
  item.verdict = evaluation.verdict ?? null
  item.marketNote = (evaluation as { marketNote?: string }).marketNote ?? null
  if (mode === 'quick') {
    // 预估不等于正式评估：不置 evaluated，入库前必须再跑一次完整评估
    item.quickEvaluated = true
    item.status = 'evaluated'
    item.stage = `预估 ${evaluation.score} 分${item.missing.length ? `（缺 ${item.missing.join('/')}，按默认值算）` : ''}`
  } else {
    item.evaluated = true
    item.quickEvaluated = false
    item.status = 'evaluated'
    item.stage = item.missing.length
      ? `已评估（注意：缺 ${item.missing.join('/')}，费率按默认值算）`
      : '已评估，待生成链接 / 入库'
  }
  item.updatedAt = new Date().toISOString()
  saveItemEvaluation(job.id, item.idx, evaluation)
  // 正式评估同时写一份「评估库」草稿（单品流程就是评估完能在评估库看到）
  if (mode === 'full') {
    try {
      item.draftId = upsertEvaluationDraft(item, source, evaluation, priceGrid)
    } catch {
      /* 草稿写失败不影响评估结果 */
    }
  }
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

/**
 * ④ 生成英文链接：**不直接进产品库**，先进待审核库（listing_reviews）。
 * 审核通过后才写 products —— 这样没审的链接不会污染产品库。
 */
async function makeListing(job: BatchJob, item: BatchItem, settings: ReturnType<typeof loadSettings>) {
  const source = item.source ?? mergeSource(item, null)
  const evaluation = getItemEvaluation(job.id, item.idx) as Evaluation | null
  if (!evaluation) {
    item.status = 'error'
    item.stage = '缺少评估结果'
    item.error = '这条没有评估结果，先做一次 AI 评估再生成链接'
    saveBatchJob(job)
    return
  }

  setStage(job, item, 'listing', '生成英文 listing（标题/卖点/描述/关键词）…')
  // 上次生成的被驳回了：先把旧记录撤掉，再重新生成一条
  if (item.reviewId) {
    const old = getListingReview(item.reviewId)
    if (old?.status === 'rejected') dropPendingReview(item.reviewId)
    item.reviewId = null
  }
  const listing = await runAi(() => generateListing(source, settings, undefined, null))
  const priceGrid = buildPriceGrid(source, settings).rows
  const review = createListingReview({
    batchJobId: job.id,
    batchIdx: item.idx,
    source,
    evaluation,
    listing,
    priceGrid,
    draftId: item.draftId ?? null,
  })
  item.reviewId = review.id
  item.status = 'review'
  item.stage = '英文链接已生成，待在「英文链接待审核」里审核'
  item.updatedAt = new Date().toISOString()
  saveBatchJob(job)
}

/**
 * ⑤ 入库一条
 *   - 生成过英文链接的：只有审核通过才算入库（产品在审核通过时就建好了，这里接回 id）
 *   - 没生成链接的：直接按评估结果入库（老路径，保持兼容）
 */
async function saveItem(job: BatchJob, item: BatchItem, settings: ReturnType<typeof loadSettings>) {
  if (item.reviewId) {
    const review = getListingReview(item.reviewId)
    if (!review) {
      item.status = 'error'
      item.stage = '审核记录已删除'
      item.error = '这条的英文链接在待审核库里被删掉了，请重新生成'
      saveBatchJob(job)
      return
    }
    if (review.status === 'rejected') {
      item.status = 'error'
      item.stage = '英文链接被驳回'
      item.error = `审核驳回${review.reviewNote ? `：${review.reviewNote}` : ''}（改完资料可重新生成）`
      saveBatchJob(job)
      return
    }
    if (review.status !== 'approved' || !review.productId) {
      item.status = 'review'
      item.stage = '还在待审核，审核通过后自动进产品库'
      saveBatchJob(job)
      return
    }
    item.productId = review.productId
    item.status = 'done'
    item.stage = '完成（审核通过，已进产品库）'
    item.updatedAt = new Date().toISOString()
    saveBatchJob(job)
    return
  }

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
  // 评估库那条草稿在评估时就建好了，这里复用；没有才补一条
  const priceGrid = buildPriceGrid(source, settings).rows
  let draftId = item.draftId ?? null
  if (!draftId || !db.prepare('SELECT id FROM drafts WHERE id = ?').get(draftId)) {
    draftId = randomUUID()
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
  }
  item.draftId = draftId

  const productId = insertProduct({
    source,
    evaluation,
    listing: null,
    similar: null,
    status: 'sourced',
    draftId,
  })
  item.productId = productId
  item.status = 'done'
  item.stage = '完成（已入库）'
  item.updatedAt = new Date().toISOString()
  saveBatchJob(job)
}

/** 根据条目状态推断整批走到哪一站（按「还没失败的那批条目」整体判断，混合状态才不会误报） */
function computePhase(job: BatchJob): BatchPhase {
  const live = job.items.filter((i) => i.status !== 'error' && i.status !== 'skipped')
  if (!live.length) return 'draft'
  if (live.every((i) => i.productId)) return 'saved'
  if (live.every((i) => i.reviewId)) return 'listed'
  if (live.every((i) => i.evaluated)) return 'evaluated'
  if (live.every((i) => i.source)) return 'fetched'
  return 'draft'
}

/** 抓取只针对「还没有资料」的条目，避免每次点抓取都把已抓过的重抓一遍 */
function fetchTargets(item: BatchItem): boolean {
  return Boolean(item.url) && !item.source && !item.productId && !item.reviewId
}

/**
 * 选品预估：只要标题 + 采购价就能先算一版（缺箱规按默认值估运费）。
 * 目的是让 50 条链接先粗筛一遍，不值得做的不用再去问商家要箱规。
 * 注意：预估结果会标「估算」，不能直接入库，必须做一次正式评估。
 */
function quickTargets(item: BatchItem): boolean {
  const s = item.source
  return (
    Boolean(s?.sourceTitle?.trim()) &&
    Number(s?.priceCny) > 0 &&
    !item.productId &&
    !item.reviewId &&
    !item.evaluated
  )
}

function evaluateTargets(item: BatchItem): boolean {
  return canEvaluate(item) && !item.productId && !item.reviewId && !item.evaluated
}

/** 生成英文链接：评估过、还没生成过的；被驳回的允许重新生成 */
function listingTargets(item: BatchItem): boolean {
  if (item.productId || !item.evaluated) return false
  if (!item.reviewId) return true
  const old = getListingReview(item.reviewId)
  return Boolean(old && old.status === 'rejected')
}

/**
 * 入库：两条路都要认 ——
 *   ① 生成过英文链接的：审核通过才算（审核通过时产品已经建好，这里只把 id 接回来）
 *   ② 没生成链接、直接评估完就入库的（老路径）
 */
function saveTargets(item: BatchItem): boolean {
  if (item.productId) return false
  if (item.reviewId) return true
  return Boolean(item.evaluated)
}

/** 跑指定阶段：逐条串行，任何一条失败只标记这一条 */
async function runStage(jobId: string, stage: BatchStage, idxs: number[] | null) {
  const job = getBatchJob(jobId)
  if (!job) return
  if (running.has(jobId)) return
  running.add(jobId)
  stopRequests.delete(jobId)
  job.status = 'running'
  job.lastStage = stage
  saveBatchJob(job)
  const settings = loadSettings()
  const picked = (item: BatchItem) => !idxs || idxs.includes(item.idx)
  const stopped = () => stopRequests.has(jobId)

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
        if (stopped()) break
        if (!picked(item) || !fetchTargets(item)) continue
        await step(() => fetchItem(job, item), item, 500)
      }
    }
    if (stage === 'quick') {
      for (const item of job.items) {
        if (stopped()) break
        if (!picked(item) || !quickTargets(item)) continue
        await step(() => evaluateItem(job, item, settings, 'quick'), item, 700)
      }
    }
    if (stage === 'evaluate' || stage === 'all') {
      for (const item of job.items) {
        if (stopped()) break
        if (!picked(item) || !evaluateTargets(item)) continue
        // 没抓过资料的（纯手填），先合并一次 source，保证评估用的是手填值
        if (!item.evaluated) await step(() => evaluateItem(job, item, settings, 'full'), item, 700)
      }
    }
    if (stage === 'listing' || stage === 'all') {
      for (const item of job.items) {
        if (stopped()) break
        if (!picked(item) || !listingTargets(item)) continue
        await step(() => makeListing(job, item, settings), item, 700)
      }
    }
    if (stage === 'save' || stage === 'all') {
      for (const item of job.items) {
        if (stopped()) break
        if (!picked(item) || !saveTargets(item)) continue
        await step(() => saveItem(job, item, settings), item, 400)
      }
    }
  } finally {
    const req = stopRequests.get(jobId)
    job.phase = computePhase(job)
    job.status = req === 'pause' ? 'paused' : req === 'stop' ? 'cancelled' : 'done'
    if (req) {
      job.items = job.items.map((i) =>
        ['fetching', 'evaluating', 'saving', 'listing'].includes(i.status)
          ? { ...i, status: 'pending', stage: STOP[req] }
          : i
      )
    }
    saveBatchJob(job)
    running.delete(jobId)
    stopRequests.delete(jobId)
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
 * 跑阶段（每个阶段都能单独点，也能一键跑完）：
 *   fetch    信息预填：抓 1688 / 命中资料库，抓完停下等人补箱规
 *   quick    选品预估：字段不全也能先粗评一版，用来筛掉明显不值得做的
 *   evaluate AI 评估：正式评分（要求 6 个关键字段齐全）
 *   listing  生成英文链接 → 进待审核库（不直接进产品库）
 *   save     入库产品库（生成过链接的必须审核通过）
 *   all      一口气跑完（跳过人工补全，缺字段按默认值算，可随时暂停）
 */
batchRouter.post('/jobs/:id/run', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const job = getBatchJob(id)
  if (!job) throw new AppError(404, '任务不存在')
  if (running.has(id)) throw new AppError(409, '这一批还在跑，等它跑完再点')

  const body = z
    .object({
      stage: z.enum(['fetch', 'quick', 'evaluate', 'listing', 'save', 'all']).default('all'),
      idxs: z.array(z.number().int().positive()).max(MAX_BATCH_ITEMS).optional(),
    })
    .parse(req.body ?? {})

  const idxs = body.idxs && body.idxs.length ? body.idxs : null
  const candidates = job.items.filter((it) => (idxs ? idxs.includes(it.idx) : true))
  const pickTargets = (stage: BatchStage) =>
    stage === 'fetch'
      ? fetchTargets
      : stage === 'quick'
        ? quickTargets
        : stage === 'evaluate'
          ? evaluateTargets
          : stage === 'listing'
            ? listingTargets
            : saveTargets
  const eligible =
    body.stage === 'all'
      ? candidates.some((it) => fetchTargets(it) || evaluateTargets(it) || listingTargets(it) || saveTargets(it))
      : candidates.some(pickTargets(body.stage))

  if (!eligible) {
    const msg =
      body.stage === 'fetch'
        ? '没有需要抓取的条目（都抓过了，或没有链接）'
        : body.stage === 'quick'
          ? '没有可预估的条目（需要至少有标题和采购价）'
          : body.stage === 'evaluate'
            ? '没有可评估的条目（缺标题/关键字段，或已评估、已生成链接、已入库）'
            : body.stage === 'listing'
              ? '没有可生成英文链接的条目（要先完成 AI 评估）'
              : '没有可入库的条目（还没评估，或已入库；生成过链接的要先审核通过）'
    throw new AppError(400, msg)
  }

  job.status = 'running'
  saveBatchJob(job)
  void runStage(id, body.stage, idxs)
  res.json({ ok: true, job: getBatchJob(id) ?? job })
})

/** 暂停：正在跑的这一条跑完就停，进度全部保留，点「继续」接着跑 */
batchRouter.post('/jobs/:id/pause', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const job = getBatchJob(id)
  if (!job) throw new AppError(404, '任务不存在')
  if (!running.has(id)) {
    // 没有真的在跑（比如服务重启过）：直接把状态改成暂停，别让界面一直转圈
    job.status = job.status === 'running' ? 'paused' : job.status
    saveBatchJob(job)
    res.json({ ok: true, job })
    return
  }
  stopRequests.set(id, 'pause')
  res.json({ ok: true, job: getBatchJob(id) ?? job, message: '正在跑的这一条跑完就暂停' })
})

/** 老任务没记 lastStage 时，按条目现有进度推断该从哪一步接着跑 */
function inferStage(job: BatchJob): BatchStage {
  if (job.lastStage) return job.lastStage
  const live = job.items.filter((i) => i.status !== 'error' && i.status !== 'skipped')
  // 还有没评估的 → 先评估；全都评估过了才往生成链接/入库走，避免白花钱生成
  if (live.some((i) => i.source && !i.evaluated)) return 'evaluate'
  if (live.some((i) => i.evaluated && !i.reviewId)) return 'listing'
  if (live.some((i) => i.reviewId && !i.productId)) return 'save'
  if (live.some((i) => !i.source)) return 'fetch'
  return 'evaluate'
}

/** 继续：按上次跑的阶段接着跑（已完成的条目会自动跳过） */
batchRouter.post('/jobs/:id/resume', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const job = getBatchJob(id)
  if (!job) throw new AppError(404, '任务不存在')
  if (running.has(id)) throw new AppError(409, '这一批正在跑')
  const stage = inferStage(job)
  job.status = 'running'
  saveBatchJob(job)
  void runStage(id, stage, null)
  res.json({ ok: true, job: getBatchJob(id) ?? job, stage })
})

/** 停：结束这一轮（条目都保留，随时可以再点别的阶段） */
batchRouter.post('/jobs/:id/cancel', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const job = getBatchJob(id)
  if (!job) throw new AppError(404, '任务不存在')
  if (!running.has(id)) {
    job.status = 'cancelled'
    saveBatchJob(job)
    res.json({ ok: true, job })
    return
  }
  stopRequests.set(id, 'stop')
  res.json({ ok: true, job: getBatchJob(id) ?? job, message: '正在跑的这一条跑完就停' })
})

/** 改一条的资料（补全箱规/每箱数/毛重这些 1688 抓不到的字段） */
batchRouter.patch('/jobs/:id/items/:idx', async (req: Request, res: Response) => {
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
        title: z.string().max(2000).optional(),
        priceCny: z.number().nullable().optional(),
        moq: z.number().nullable().optional(),
        sizeCn: z.string().max(2000).optional(),
        materialCn: z.string().max(1000).optional(),
        colorsCn: z.string().max(1000).optional(),
        description: z.string().max(20000).optional(),
        // 图可能是资料库里的 data URL（一张几十 KB），按 URL 的 4000 字符上限会直接把保存打回 400
        images: z.array(z.string().max(2_000_000)).max(12).optional(),
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
  // 外链图片（1688 的图有防盗链，页面上会显示成破损图）在这里换成 data URL
  let imagesDropped = 0
  if ((item.source.images ?? []).some((u) => /^https?:/i.test(u))) {
    const inlined = await inlineImages(item.source.images)
    item.source = { ...item.source, images: inlined.images }
    item.input = { ...item.input, images: inlined.images }
    imagesDropped = inlined.dropped
  }
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
  // 资料改了，之前生成的英文链接就过期了：把待审核记录撤掉，避免审的是旧内容
  if (item.reviewId) {
    const dropped = dropPendingReview(item.reviewId)
    if (dropped) {
      item.reviewId = null
      item.stage = '资料已改，旧英文链接已撤回，需重新生成'
    }
  }
  item.updatedAt = new Date().toISOString()
  job.phase = computePhase(job)
  saveBatchJob(job)
  res.json({ ok: true, job, imagesDropped })
})

/**
 * 一次性修复：把历史条目/资料库里存的外链图片（1688 防盗链，页面显示破损）
 * 下载转存成 data URL。部署后由我调一次即可，不需要用户逐条点保存。
 */
batchRouter.post('/maintenance/inline-images', async (_req: Request, res: Response) => {
  const jobs = listBatchJobs(50)
  const settings = loadSettings()
  let items = 0
  let images = 0
  let dropped = 0
  let drafts = 0
  for (const summary of jobs) {
    const job = getBatchJob(summary.id)
    if (!job) continue
    let changed = false
    for (const item of job.items) {
      const imgs = item.source?.images ?? []
      if (imgs.some((u) => /^https?:/i.test(u))) {
        const r = await inlineImages(imgs)
        item.source = item.source ? { ...item.source, images: r.images } : item.source
        item.input = { ...item.input, images: r.images }
        images += r.images.length
        dropped += r.dropped
        items += 1
        changed = true
      }
      // 已经评估过但评估库里没有草稿的（拆阶段之前的批次）：补一条，评估库才看得到
      if (item.evaluated && !item.draftId && item.source) {
        const ev = getItemEvaluation(job.id, item.idx) as Evaluation | null
        if (ev) {
          try {
            item.draftId = upsertEvaluationDraft(
              item,
              item.source,
              ev,
              buildPriceGrid(item.source, settings).rows
            )
            drafts += 1
            changed = true
          } catch {
            /* 单条失败不影响其它条 */
          }
        }
      }
    }
    if (changed) saveBatchJob(job)
  }

  // 资料库里的外链图同样处理
  let master = 0
  try {
    const rows = db
      .prepare("SELECT id, images FROM master_products WHERE images LIKE '%http%'")
      .all() as unknown as Array<{ id: string; images: string }>
    for (const row of rows) {
      const imgs = JSON.parse(row.images) as string[]
      if (!imgs.some((u) => /^https?:/i.test(u))) continue
      const r = await inlineImages(imgs)
      db.prepare('UPDATE master_products SET images=?, updated_at=? WHERE id=?').run(
        JSON.stringify(r.images),
        new Date().toISOString(),
        row.id
      )
      master += 1
      dropped += r.dropped
    }
  } catch {
    /* 资料库修不了不影响主流程 */
  }

  res.json({ ok: true, batchItems: items, masterProducts: master, images, dropped, drafts })
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
