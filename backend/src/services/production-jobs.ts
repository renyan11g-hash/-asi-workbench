/**
 * 批量生产任务（批量生产系统 V1 · 第二/四/五阶段的后端）。
 *
 * 与 batch_jobs 的区别：
 *   batch_jobs       = 从「1688 链接」起跑：抓取 → 人工补全 → 评估 → 入库 → 出文案
 *   production_jobs  = 从「已有产品档案」起跑：只做文案生成 / 资料结构化
 * 两者互不干扰：这里不碰 batch_jobs，也不改单品流程的任何规则。
 *
 * 设计要点（对应需求第四阶段）：
 *   · 每个产品一条 item，独立状态、独立错误；一条失败绝不影响其他条
 *   · 状态落库，刷新页面/服务重启（每次发版都会重启）都能接着跑
 *   · 暂停/继续/取消在「两条产品之间」生效（正在生成的那一条会跑完，不会被腰斩）
 *   · clientKey 挡住手抖连点：同一把钥匙 + 还在排队/运行 → 直接返回原任务
 */

import { db } from '../db'
import type {
  Listing,
  ProductSpecs,
  ProductionItem,
  ProductionJob,
  ProductionJobKind,
  ProductionJobStatus,
  Settings,
} from '../types'
import { findProduct } from '../modules/products'
import { evaluateSource, findSimilarForSource, generateListing, hasSimilarResearch } from './workbench'
import { extractSpecs, getSpecRecord, saveSpecs, specsSourceHash } from './product-specs'
import { runListingQc } from './listing-qc'
import { createStagedListingReview } from '../modules/listing-reviews'
import { loadSettings } from '../modules/settings'
import { randomUUID } from 'crypto'

/** 一批最多几个：再多就是压测了（每个产品 30~90 秒） */
export const MAX_PRODUCTION_ITEMS = 20
/** 用户实际使用建议 5～10 个，界面上按这个提示 */
export const SUGGESTED_PRODUCTION_ITEMS = 10

interface JobRow {
  id: string
  kind: string
  status: string
  options: string
  items: string
  note: string
  client_key: string | null
  created_at: string
  updated_at: string
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

function rowToJob(r: JobRow): ProductionJob {
  return {
    id: r.id,
    kind: (r.kind as ProductionJobKind) ?? 'listing',
    status: (r.status as ProductionJobStatus) ?? 'queued',
    items: safeJson<ProductionItem[]>(r.items, []),
    note: r.note ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function getJob(id: string): ProductionJob | null {
  const row = db.prepare('SELECT * FROM production_jobs WHERE id = ?').get(id) as
    | unknown
    | JobRow
    | undefined
  return row ? rowToJob(row as JobRow) : null
}

export function listJobs(limit = 20): ProductionJob[] {
  const rows = db
    .prepare('SELECT * FROM production_jobs ORDER BY created_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(50, limit))) as unknown as JobRow[]
  return rows.map(rowToJob)
}

export function saveJob(job: ProductionJob): void {
  job.updatedAt = new Date().toISOString()
  db.prepare(
    'UPDATE production_jobs SET status=?, items=?, note=?, updated_at=? WHERE id=?'
  ).run(job.status, JSON.stringify(job.items), job.note, job.updatedAt, job.id)
}

/** 还在排队/运行/暂停/中断的任务（同一个 clientKey 不会重复建） */
function findActiveByClientKey(clientKey: string): ProductionJob | null {
  if (!clientKey) return null
  const row = db
    .prepare(
      "SELECT * FROM production_jobs WHERE client_key = ? AND status IN ('queued','running','paused','interrupted') ORDER BY created_at DESC LIMIT 1"
    )
    .get(clientKey) as unknown as JobRow | undefined
  return row ? rowToJob(row) : null
}

export interface CreateJobInput {
  kind: ProductionJobKind
  productIds: string[]
  note?: string
  /** 幂等键：同一次点击重复提交只会产生一个任务 */
  clientKey?: string
  options?: Record<string, unknown>
}

export interface CreateJobResult {
  job: ProductionJob
  /** true = 命中幂等，返回的是已存在的那个任务 */
  deduped: boolean
  /** 被跳过的产品（不存在 / 已在回收站） */
  skipped: Array<{ productId: string; reason: string }>
}

export function createJob(input: CreateJobInput): CreateJobResult {
  if (input.clientKey) {
    const existing = findActiveByClientKey(input.clientKey)
    if (existing) return { job: existing, deduped: true, skipped: [] }
  }

  const ids = Array.from(new Set(input.productIds.filter(Boolean))).slice(0, MAX_PRODUCTION_ITEMS)
  if (!ids.length) throw new Error('没有选中任何产品')

  const skipped: Array<{ productId: string; reason: string }> = []
  const items: ProductionItem[] = []
  ids.forEach((productId, i) => {
    try {
      const p = findProduct(productId)
      if (p.status === 'trashed') {
        skipped.push({ productId, reason: '在回收站里' })
        return
      }
      items.push({
        idx: i + 1,
        productId,
        code: p.code || '',
        title: p.source.sourceTitle || p.listing?.title || '(未命名产品)',
        status: 'queued',
        stage: '排队中',
      })
    } catch {
      skipped.push({ productId, reason: '产品档案不存在' })
    }
  })
  if (!items.length) throw new Error('选中的产品都不可用（可能已删除或在回收站）')

  const id = `prod_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO production_jobs (id, kind, status, options, items, note, client_key, created_at, updated_at)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.kind,
    JSON.stringify(input.options ?? {}),
    JSON.stringify(items),
    input.note ?? '',
    input.clientKey ?? null,
    now,
    now
  )
  const job = getJob(id) as ProductionJob
  return { job, deduped: false, skipped }
}

export function updateItem(
  jobId: string,
  idx: number,
  patch: Partial<ProductionItem>
): ProductionJob | null {
  const job = getJob(jobId)
  if (!job) return null
  job.items = job.items.map((it) => (it.idx === idx ? { ...it, ...patch } : it))
  saveJob(job)
  return job
}

// ---------------------------------------------------------------- 执行

/** 正在跑的任务 id（内存，防同一任务被两个循环同时消费） */
const running = new Set<string>()
/** 控制意图：pause / cancel（由 HTTP 接口写入，循环在两条之间读取） */
const controlRequests = new Map<string, 'pause' | 'cancel'>()

export function isRunning(jobId: string): boolean {
  return running.has(jobId)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 服务重启（发版）时收尾：
 * 把 running 的任务标成 interrupted，把卡在 running 的条目放回 queued。
 * 不标 failed —— 重启不是数据的问题，点一次「继续」就能接着跑。
 */
export function recoverInterruptedProductionJobs(): number {
  let n = 0
  try {
    const rows = db
      .prepare("SELECT * FROM production_jobs WHERE status = 'running'")
      .all() as unknown as JobRow[]
    for (const row of rows) {
      const job = rowToJob(row)
      job.status = 'interrupted'
      job.items = job.items.map((it) =>
        it.status === 'running' ? { ...it, status: 'queued', stage: '服务重启中断，点「继续」接着跑' } : it
      )
      saveJob(job)
      n += 1
    }
  } catch {
    /* 表还没建好时忽略 */
  }
  return n
}

/** 启动（或继续）一个任务：立即返回，后台顺序跑 */
export function startJob(jobId: string): ProductionJob | null {
  const job = getJob(jobId)
  if (!job) return null
  if (running.has(jobId)) return job
  if (job.status === 'done' || job.status === 'cancelled') return job
  controlRequests.delete(jobId)
  job.status = 'running'
  saveJob(job)
  running.add(jobId)
  void loop(jobId)
  return job
}

/** 暂停：置标志 + 立刻把状态写库，界面马上能看到「已暂停」 */
export function pauseJob(jobId: string): ProductionJob | null {
  const job = getJob(jobId)
  if (!job) return null
  job.status = 'paused'
  saveJob(job)
  controlRequests.set(jobId, 'pause')
  return job
}

export function cancelJob(jobId: string): ProductionJob | null {
  const job = getJob(jobId)
  if (!job) return null
  job.status = 'cancelled'
  job.items = job.items.map((it) =>
    it.status === 'queued' ? { ...it, status: 'cancelled', stage: '已取消' } : it
  )
  saveJob(job)
  controlRequests.set(jobId, 'cancel')
  return job
}

/** 只重试失败的条目（用户最常用的动作） */
export function retryFailed(jobId: string): ProductionJob | null {
  const job = getJob(jobId)
  if (!job) return null
  job.items = job.items.map((it) =>
    it.status === 'failed'
      ? { ...it, status: 'queued', stage: '等待重试', error: undefined, qcIssues: [] }
      : it
  )
  job.status = 'queued'
  saveJob(job)
  return startJob(jobId)
}

/** 单条重试（某一条失败卡片上的「重试这一条」） */
export function retryItem(jobId: string, idx: number): ProductionJob | null {
  const job = getJob(jobId)
  if (!job) return null
  job.items = job.items.map((it) =>
    it.idx === idx
      ? { ...it, status: 'queued', stage: '等待重试', error: undefined, qcIssues: [], reviewId: null }
      : it
  )
  saveJob(job)
  return startJob(jobId)
}

/** 继续：把 paused/interrupted 重新跑起来 */
export function resumeJob(jobId: string): ProductionJob | null {
  const job = getJob(jobId)
  if (!job) return null
  // 中断时可能还剩 running 没落回 queued 的条目，一并归位
  job.items = job.items.map((it) =>
    it.status === 'running' ? { ...it, status: 'queued', stage: '等待继续' } : it
  )
  job.status = 'queued'
  saveJob(job)
  return startJob(jobId)
}

async function loop(jobId: string): Promise<void> {
  try {
    for (;;) {
      const job = getJob(jobId)
      if (!job) break
      const ctrl = controlRequests.get(jobId)
      if (ctrl || job.status === 'paused' || job.status === 'cancelled') break

      const next = job.items.find((it) => it.status === 'queued')
      if (!next) break

      await runOne(jobId, next)
      // 每条之间喘一口：连续轰 AI 接口容易 429，也让「暂停」有地方插进来
      await sleep(400)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      const job = getJob(jobId)
      if (job) {
        job.status = 'interrupted'
        job.note = `${job.note ? `${job.note}；` : ''}任务循环异常：${message}`.slice(0, 500)
        saveJob(job)
      }
    } catch {
      /* ignore */
    }
  } finally {
    running.delete(jobId)
    controlRequests.delete(jobId)
    // 收尾：还有 queued 却没在跑 → 说明是暂停/取消，状态已经写好了；否则标 done
    try {
      const job = getJob(jobId)
      if (job && job.status === 'running') {
        const hasQueued = job.items.some((it) => it.status === 'queued')
        job.status = hasQueued ? 'paused' : 'done'
        saveJob(job)
      }
    } catch {
      /* ignore */
    }
  }
}

async function runOne(jobId: string, item: ProductionItem): Promise<void> {
  const job = getJob(jobId)
  if (!job) return
  const startedAt = Date.now()
  updateItem(jobId, item.idx, {
    status: 'running',
    stage: job.kind === 'spec' ? '正在提取结构化资料…' : '正在生成英文 Listing…',
    startedAt: new Date(startedAt).toISOString(),
    error: undefined,
  })

  try {
    const settings: Settings = loadSettings()
    if (job.kind === 'spec') {
      await runSpecItem(item, settings, jobId)
    } else if (job.kind === 'evaluate') {
      await runEvalItem(item, settings, jobId)
    } else {
      await runListingItem(item, settings, jobId)
    }
    updateItem(jobId, item.idx, {
      status: 'success',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    })
  } catch (err) {
    // 单条失败只写这一条，绝不冒泡影响整批
    updateItem(jobId, item.idx, {
      status: 'failed',
      stage: '失败',
      error: err instanceof Error ? err.message : String(err),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    })
  }
}

async function runSpecItem(item: ProductionItem, settings: Settings, jobId: string): Promise<void> {
  const product = findProduct(item.productId)
  const { specs, filled, model } = await extractSpecs(product.source, settings, product.id)
  saveSpecs(product.id, specs, {
    model,
    sourceHash: specsSourceHash(product.source),
    extracted: true,
  })
  updateItem(jobId, item.idx, { filled, stage: `已提取 ${filled}/14 项` })
}

/**
 * 产品评估（一键跑完，不用人工点两次）：
 *   AI 评估（评分/结论/优缺点/改善建议）→ 看图找亚马逊与 ASI 同款 → 落库 →
 *   存进评估库（drafts）→ 标记「待人工审核」。
 * 评估通过与否由人事后在评估库/流水线批量决定，这里不替人做判断。
 */
async function runEvalItem(item: ProductionItem, settings: Settings, jobId: string): Promise<void> {
  const product = findProduct(item.productId)
  if (!settings.aiApiKey?.trim()) throw new Error('尚未配置 API Key，无法评估')

  // 抓到的类似商品关键词能省一次看图调用：有就带上，没有就让 AI 自己判断
  const evaluation = await evaluateSource(product.source, settings, {})
  const similar = await findSimilarForSource(product.source, settings)

  const now = new Date().toISOString()
  db.prepare(
    `UPDATE products SET score=?, verdict=?, evaluation=?, similar=?, eval_review='pending', updated_at=? WHERE id=?`
  ).run(evaluation.score, evaluation.verdict, JSON.stringify(evaluation), JSON.stringify(similar), now, product.id)

  // 评估库：同一条产品只维护一条草稿（草稿 id 记在 products.draft_id 上）
  const draftContent = JSON.stringify({
    kind: 'sourcing-evaluation',
    source: product.source,
    evaluation,
    similar,
    priceGrid: [],
  })
  const draftId = ensureEvalDraft(product.id, product.source.sourceTitle || product.code || '未命名产品', draftContent)

  updateItem(jobId, item.idx, {
    stage: `评估完成（${evaluation.verdict} ${evaluation.score} 分），已存入评估库，待人工审核`,
    filled: typeof evaluation.score === 'number' ? evaluation.score : null,
  })
  void draftId
}

/** 建/更新评估库草稿，返回草稿 id */
function ensureEvalDraft(productId: string, title: string, content: string): string {
  const row = db.prepare('SELECT draft_id FROM products WHERE id = ?').get(productId) as
    | { draft_id: string | null }
    | undefined
  const now = new Date().toISOString()
  const existingId = row?.draft_id
  if (existingId) {
    const hit = db.prepare('SELECT id FROM drafts WHERE id = ?').get(existingId) as { id: string } | undefined
    if (hit) {
      db.prepare('UPDATE drafts SET title = ?, content = ?, updated_at = ? WHERE id = ?').run(
        title.slice(0, 200),
        content,
        now,
        existingId
      )
      return existingId
    }
  }
  const id = randomUUID()
  db.prepare('INSERT INTO drafts (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    title.slice(0, 200),
    content,
    now,
    now
  )
  db.prepare('UPDATE products SET draft_id = ?, updated_at = ? WHERE id = ?').run(id, now, productId)
  return id
}

async function runListingItem(item: ProductionItem, settings: Settings, jobId: string): Promise<void> {
  const product = findProduct(item.productId)
  // 结构化资料存在就用它当事实清单；没有就与原流程完全一致（不强制先做结构化）
  const specRecord = getSpecRecord(product.id)
  const specs: ProductSpecs | null = specRecord?.specs ?? null

  // 文案要用市场参考（Amazon/ASI 同款搜索词与卖点）：评估那一步没跑成/没做识图时，
  // 这里补一次，保证「生成的英文链接」永远是基于真实市场词、而不是 AI 自己编的词。
  let similar = product.similar
  if (!hasSimilarResearch(similar)) {
    updateItem(jobId, item.idx, { stage: '正在看图找类似（Amazon / ASI 市场参考）' })
    try {
      similar = await findSimilarForSource(product.source, settings)
      db.prepare('UPDATE products SET similar=?, updated_at=? WHERE id=?').run(
        JSON.stringify(similar),
        new Date().toISOString(),
        product.id
      )
    } catch {
      similar = hasSimilarResearch(similar) ? similar : null
    }
  }

  const listing: Listing = await generateListing(
    product.source,
    settings,
    undefined,
    similar,
    product.evaluation ?? null,
    specs,
    product.id
  )

  // 质量检查：程序规则立刻出结果；AI 复检放到审核中心的单独动作里，避免批量时代价翻倍
  const qc = runListingQc({ listing, source: product.source, specs })

  // 关键：进「待审核」时**不写 products**（暂存模式），人工通过后才写回，
  // 所以批量生成永远不会覆盖产品库里现有的 Listing。
  const review = createStagedListingReview({
    productId: product.id,
    listing,
    qc,
    jobId,
    itemIdx: item.idx,
    source: product.source,
    evaluation: product.evaluation ?? null,
  })

  updateItem(jobId, item.idx, {
    reviewId: review.id,
    qcOk: qc.ok,
    qcIssues: qc.checks.filter((c) => !c.ok).map((c) => `${c.label}：${c.detail}`),
    stage: qc.ok ? '生成完成，质检通过' : '生成完成，质检有提示',
  })
}
