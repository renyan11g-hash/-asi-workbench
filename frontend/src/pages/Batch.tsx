import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  ClipboardPaste,
  Download,
  ExternalLink,
  ImagePlus,
  Layers,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { SectionCard, VerdictBadge } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import {
  BatchItem,
  BatchItemInput,
  BatchItemStatus,
  BatchJob,
  BatchJobStatus,
  BatchOptions,
  BatchPhase,
  BatchStage,
  SourceInfo,
} from '@/types'

const JOB_KEY = 'asi-batch:jobId'

const ITEM_STATUS: Record<BatchItemStatus, { label: string; cls: string }> = {
  pending: { label: '待处理', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  fetching: { label: '抓取中', cls: 'bg-sky-100 text-sky-700 border-sky-200' },
  fetched: { label: '待补全', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  evaluating: { label: '评估中', cls: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  evaluated: { label: '已评估', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  saving: { label: '入库中', cls: 'bg-violet-100 text-violet-700 border-violet-200' },
  listing: { label: '生成链接', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  review: { label: '待审核', cls: 'bg-orange-100 text-orange-700 border-orange-200' },
  done: { label: '已入库', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  error: { label: '失败', cls: 'bg-rose-100 text-rose-600 border-rose-200' },
  skipped: { label: '跳过', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
}

const JOB_STATUS: Record<BatchJobStatus, { label: string; cls: string }> = {
  draft: { label: '待处理', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  running: { label: '处理中', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  paused: { label: '已暂停', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  done: { label: '已停', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  cancelled: { label: '已停止', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  interrupted: { label: '已中断', cls: 'bg-rose-100 text-rose-600 border-rose-200' },
}

const PHASE_LABEL: Record<BatchPhase, string> = {
  draft: '待抓取',
  fetched: '已预填 · 待补全',
  evaluated: '已评估 · 待生成链接',
  listed: '已生成链接 · 待审核',
  saved: '已入库',
}

const STEPS: Array<{ key: string; label: string }> = [
  { key: 'draft', label: '① 信息预填' },
  { key: 'fill', label: '② 补全资料' },
  { key: 'evaluated', label: '③ 选品评估' },
  { key: 'listed', label: '④ 英文链接待审核' },
  { key: 'saved', label: '⑤ 入库产品库' },
]

function phaseStep(phase: BatchPhase): number {
  return phase === 'draft' ? 0 : phase === 'fetched' ? 1 : phase === 'evaluated' ? 2 : phase === 'listed' ? 3 : 4
}

const STAGE_LABEL: Record<BatchStage, string> = {
  fetch: '信息预填',
  quick: '选品预估',
  evaluate: 'AI 评估',
  listing: '生成英文链接',
  save: '入库产品库',
  all: '一键全流程',
}

const STAGE_START: Record<BatchStage, string> = {
  fetch: '开始信息预填：抓 1688 / 命中资料库，抓完停下来等补全',
  quick: '开始选品预估：缺字段按默认值估算，用来先筛掉不值得做的',
  evaluate: '开始 AI 评估（不落库，先看分）',
  listing: '开始生成英文链接 → 进待审核库，审核通过才进产品库',
  save: '开始入库：生成过链接的必须审核通过',
  all: '一键全流程已开始（跳过人工补全），可以随时暂停',
}

/** 一个阶段按钮：带待处理条数，0 条自动禁用 */
function StageBtn({
  label,
  count,
  hint,
  disabled,
  onClick,
}: {
  label: string
  count: number
  hint: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={[
        'flex flex-col items-start gap-1 rounded-lg border px-2.5 py-2 text-left transition',
        disabled
          ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
          : 'border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50/60',
      ].join(' ')}
    >
      <span className="flex w-full items-center justify-between gap-1 text-[12px] font-medium">
        <span className="truncate">{label}</span>
        <span
          className={[
            'rounded px-1 text-[10px]',
            count > 0 ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-400',
          ].join(' ')}
        >
          {count}
        </span>
      </span>
      <span className="line-clamp-1 text-[10px] leading-tight text-slate-400">{hint}</span>
    </button>
  )
}

const DEFAULT_OPTIONS: BatchOptions = { fetch: true, evaluate: true, save: true, listing: false }

const SAMPLE = `图片	链接	标题	采购价	MOQ	尺寸	材质	颜色	箱规	每箱数	箱毛重
https://img.alicdn.com/1.jpg https://img.alicdn.com/2.jpg	https://detail.1688.com/offer/123456789.html	折叠收纳盒	3.5	100	20x15x8cm	PU皮	黑/灰	40x30x25	60	12
https://img.alicdn.com/3.jpg	https://detail.1688.com/offer/123456790.html	硅胶杯托	2.8	200	12x12x3cm	硅胶	三色	45x35x30	120	9`

/** 缺哪些关键字段（与后端 missingFields 一致，用于逐个输入框标黄） */
function fieldMissing(source: SourceInfo | null | undefined, key: keyof BatchItemInput): boolean {
  if (!source) return true
  if (key === 'priceCny') return !(Number(source.priceCny) > 0)
  if (key === 'pcsPerCarton') return !source.pcsPerCarton
  if (key === 'cartonGwKg') return !source.cartonGwKg
  if (key === 'sizeCn') return !(source.sizeCn ?? '').trim()
  if (key === 'materialCn') return !(source.materialCn ?? '').trim()
  return false
}

function cartonMissing(source: SourceInfo | null | undefined): boolean {
  return !(source?.cartonLCm && source?.cartonWCm && source?.cartonHCm)
}

/** 从条目现有资料生成编辑表单初值 */
function draftFromItem(item: BatchItem): BatchItemInput {
  const s = item.source
  return {
    title: s?.sourceTitle ?? item.input.title ?? '',
    priceCny: s?.priceCny ? s.priceCny : null,
    moq: s?.moq ? s.moq : null,
    sizeCn: s?.sizeCn ?? '',
    materialCn: s?.materialCn ?? '',
    colorsCn: s?.colorsCn ?? '',
    weightG: s?.weightG ?? null,
    cartonLCm: s?.cartonLCm ?? null,
    cartonWCm: s?.cartonWCm ?? null,
    cartonHCm: s?.cartonHCm ?? null,
    pcsPerCarton: s?.pcsPerCarton ?? null,
    cartonGwKg: s?.cartonGwKg ?? null,
    description: s?.description ?? '',
    // 图片跟着一起带进表单，补全时可以增删
    images: s?.images ?? [],
  }
}

/** 输入框里的空串要变成 null，否则会把抓到的值覆盖成 0 */
function numberOrNull(v: string): number | null {
  const t = v.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/**
 * 本地图片 → 最长边 900px 的 JPEG data URL。
 * 手机/相机原图动辄 3–5MB，直接塞进保存请求会把一次保存撑成几十 MB（还容易被 413 打回），
 * 而补全时加图只是给「评估认品类 / 出图参考」用，900px 完全够。
 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = () => {
      const src = String(reader.result ?? '')
      const img = new Image()
      img.onerror = () => reject(new Error('这张图打不开'))
      img.onload = () => {
        const scale = Math.min(1, 900 / Math.max(img.width || 1, img.height || 1))
        const w = Math.max(1, Math.round((img.width || 1) * scale))
        const h = Math.max(1, Math.round((img.height || 1) * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(src)
          return
        }
        // 透明底 JPEG 会变黑，先铺白（和出图要求的纯白背景也一致）
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.82))
      }
      img.src = src
    }
    reader.readAsDataURL(file)
  })
}

/** 表格里的小缩略图：让人一眼看出这条到底有没有图、存了几张 */
function ImageStack({ images }: { images: string[] }) {
  if (!images.length) return <span className="text-slate-300">—</span>
  const show = images.slice(0, 3)
  return (
    <div className="flex items-center gap-1">
      {show.map((u, i) => (
        <img
          key={`${u.slice(0, 24)}-${i}`}
          src={u}
          alt=""
          className="h-8 w-8 rounded border border-slate-200 bg-white object-cover"
        />
      ))}
      {images.length > show.length && (
        <span className="text-[10px] text-slate-400">+{images.length - show.length}</span>
      )}
    </div>
  )
}

/**
 * 批量处理：粘贴多条产品 → 抓取 → **人工补全（箱规等 1688 抓不到的字段）** → 评估 → 入库。
 *
 * 刻意不在这里做任何新的业务判断：每一步都调用单品流程的服务端函数，
 * 所以评分/印刷方式/报价/市场探针与单品完全一致，这里只负责排队、补全和展示进度。
 */
export default function Batch() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [options] = useState<BatchOptions>(DEFAULT_OPTIONS)
  const [creating, setCreating] = useState(false)
  const [job, setJob] = useState<BatchJob | null>(null)
  const [jobId, setJobId] = useState<string | null>(() => localStorage.getItem(JOB_KEY))
  const [nonce, setNonce] = useState(0)
  const [recent, setRecent] = useState<
    Array<{
      id: string
      status: BatchJobStatus
      phase: BatchPhase
      note: string
      total: number
      fetched: number
      evaluated: number
      done: number
      failed: number
      missing: number
      createdAt: string
    }>
  >([])
  // 正在编辑的条目（idx）
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [draft, setDraft] = useState<BatchItemInput>({})
  const [savingEdit, setSavingEdit] = useState(false)
  /** 保存失败的具体原因（弹 toast 容易错过，直接钉在表单里） */
  const [saveError, setSaveError] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  /** 勾选的条目 idx（用于批量删除） */
  const [selected, setSelected] = useState<number[]>([])
  const [deleting, setDeleting] = useState(false)
  const [grabbingImages, setGrabbingImages] = useState(false)
  /** 英文链接待审核条数（顶部入口用） */
  const [reviewPending, setReviewPending] = useState(0)

  const loadRecent = useCallback(async () => {
    try {
      const r = await api.listBatchJobs()
      setRecent(r.jobs)
    } catch {
      /* 历史任务拉不到不影响主流程 */
    }
  }, [])

  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  // 待审核英文链接数量：批次跑完/暂停时顺手刷新一下
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await api.listListingReviews({ status: 'pending', limit: 1 })
        if (alive) setReviewPending(r.counts?.pending ?? 0)
      } catch {
        /* 拿不到不影响批量处理 */
      }
    }
    void load()
    const t = window.setInterval(load, 15000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [nonce, job?.status])

  // 轮询：只要任务还在跑就每 2.5 秒刷新一次进度（顺手把服务端保活，避免免费层休眠）
  useEffect(() => {
    if (!jobId) return
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      if (!alive) return
      try {
        const j = await api.getBatchJob(jobId)
        if (!alive) return
        setJob(j)
        if (j.status === 'running') {
          timer = window.setTimeout(tick, 2500)
        } else {
          void loadRecent()
        }
      } catch (err) {
        if (!alive) return
        const msg = getErrorMessage(err)
        if (/不存在/.test(msg)) {
          setJob(null)
          setJobId(null)
          localStorage.removeItem(JOB_KEY)
          return
        }
        timer = window.setTimeout(tick, 4000)
      }
    }
    void tick()
    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
    }
  }, [jobId, nonce, loadRecent])

  const items = job?.items ?? []
  const isRunning = job?.status === 'running'

  const stats = useMemo(() => {
    const total = items.length
    const fetched = items.filter((i) => Boolean(i.source)).length
    const evaluated = items.filter((i) => i.evaluated).length
    const saved = items.filter((i) => Boolean(i.productId)).length
    const failed = items.filter((i) => i.status === 'error').length
    const missingItems = items.filter((i) => (i.missing?.length ?? 0) > 0 && i.status !== 'error')
    const canEval = items.filter((i) => !i.evaluated && !i.productId && i.status !== 'error').length
    return { total, fetched, evaluated, saved, failed, missing: missingItems.length, canEval }
  }, [items])

  const stageCounts = useMemo(() => {
    const live = items.filter((i) => i.status !== 'error')
    const fetch = live.filter((i) => i.url && !i.source && !i.productId && !i.reviewId).length
    const quick = live.filter((i) => {
      const s = i.source
      return (
        Boolean(s?.sourceTitle?.trim()) &&
        Number(s?.priceCny) > 0 &&
        !i.productId &&
        !i.reviewId &&
        !i.evaluated
      )
    }).length
    const evaluate = live.filter(
      (i) => !i.evaluated && !i.productId && !i.reviewId && (i.missing?.length ?? 0) === 0 && Boolean(i.source?.sourceTitle)
    ).length
    const listing = live.filter((i) => i.evaluated && !i.productId && !i.reviewId).length
    const save = live.filter((i) => !i.productId && (Boolean(i.reviewId) || Boolean(i.evaluated))).length
    return { fetch, quick, evaluate, listing, save }
  }, [items])

  const start = async () => {
    if (!text.trim()) {
      toast.error('先把产品链接粘贴进来')
      return
    }
    setCreating(true)
    try {
      const r = await api.createBatchJob({ text, options })
      setJob(r.job)
      setJobId(r.job.id)
      localStorage.setItem(JOB_KEY, r.job.id)
      setNonce((n) => n + 1)
      void loadRecent()
      toast.success(
        `已排入 ${r.job.items.length} 条${r.skipped ? `（${r.skipped} 行已跳过）` : ''}，下一步点「① 抓取资料」`
      )
      if (r.truncated) toast.warning('一次最多处理 50 条，超出部分没有提交')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  const run = async (stage: BatchStage, idxs?: number[]) => {
    if (!jobId) return
    try {
      await api.runBatchStage(jobId, stage, idxs)
      setNonce((n) => n + 1)
      toast.success(STAGE_START[stage])
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const pause = async () => {
    if (!jobId) return
    try {
      const j = await api.pauseBatchJob(jobId)
      setJob(j)
      setNonce((n) => n + 1)
      toast.success('已暂停：正在跑的这一条跑完就停，进度都保住了')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const resume = async () => {
    if (!jobId) return
    try {
      const r = await api.resumeBatchJob(jobId)
      setJob(r.job)
      setNonce((n) => n + 1)
      toast.success(`继续跑「${STAGE_LABEL[(r.stage as BatchStage) ?? 'evaluate']}」`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const stop = async () => {
    if (!jobId) return
    try {
      const j = await api.cancelBatchJob(jobId)
      setJob(j)
      setNonce((n) => n + 1)
      toast.success('已发送停止指令：正在跑的这一条结束后就停')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const retry = async () => {
    if (!jobId) return
    try {
      const j = await api.retryBatchJob(jobId)
      setJob(j)
      setNonce((n) => n + 1)
      toast.success('已把失败的条目放回队列')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const openEdit = (item: BatchItem) => {
    setEditingIdx(item.idx)
    setDraft(draftFromItem(item))
    setSaveError('')
  }

  /** 从 1688 链接抓多张产品图，塞进当前编辑的条目 */
  const grabImages = async (url: string) => {
    if (!url) {
      toast.error('这条没有 1688 链接，直接粘贴图片地址吧')
      return
    }
    setGrabbingImages(true)
    try {
      const r = await api.fetch1688Images(url)
      if (!r.images?.length) {
        toast.warning(r.message || '没抓到图，可以手动粘贴图片地址')
        return
      }
      setDraft((d) => ({
        ...d,
        images: Array.from(new Set([...(d.images ?? []), ...r.images])).slice(0, 8),
      }))
      toast.success(r.source === 'master' ? '已用产品资料库里的图' : `抓到 ${r.images.length} 张图`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setGrabbingImages(false)
    }
  }

  const toggleSelect = (idx: number) => {
    setSelected((cur) => (cur.includes(idx) ? cur.filter((i) => i !== idx) : [...cur, idx]))
  }

  const deleteSelected = async () => {
    if (!jobId || selected.length === 0) return
    setDeleting(true)
    try {
      const r = await api.deleteBatchItems(jobId, selected)
      setJob(r.job)
      setSelected([])
      if (r.skipped > 0) {
        toast.warning(`已删 ${r.removed} 条；${r.skipped} 条已入库，没有删（产品库里还在）`)
      } else {
        toast.success(`已删除 ${r.removed} 条`)
      }
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDeleting(false)
    }
  }

  const saveEdit = async (thenEvaluate: boolean) => {
    const idx = editingIdx
    if (!jobId || idx === null) return
    setSavingEdit(true)
    setSaveError('')
    let saved = false
    try {
      const r = await api.patchBatchItem(jobId, idx, draft)
      setJob(r.job)
      setEditingIdx(null)
      saved = true
      if (r.imagesDropped > 0) {
        toast.warning(`有 ${r.imagesDropped} 张图下载失败（1688 防盗链），已跳过，可手动上传`)
      }
      if (!thenEvaluate) toast.success(`第 ${idx} 条资料已保存`)
    } catch (err) {
      const msg = getErrorMessage(err)
      setSaveError(msg)
      toast.error(msg)
    } finally {
      setSavingEdit(false)
    }
    // 评估单独一段：保存已经成功时，评估失败不能再报「保存失败」，否则会误导
    if (saved && thenEvaluate) {
      try {
        await api.runBatchStage(jobId, 'evaluate', [idx])
        setNonce((n) => n + 1)
        toast.success(`第 ${idx} 条已保存并开始评估`)
      } catch (err) {
        const msg = getErrorMessage(err)
        toast.error(`资料已保存，但评估没跑起来：${msg}`)
      }
    }
  }

  const copyAskSupplier = (item: BatchItem) => {
    const name = item.source?.sourceTitle || item.input.title || '该产品'
    const msg = `您好，我想采购「${name}」用于出口定制，麻烦提供以下信息：
1. 外箱尺寸（长×宽×高，cm）
2. 每箱装多少个？
3. 整箱毛重（kg）？
4. 单个产品净重（g）和尺寸？
5. 材质是什么？有哪些颜色？
6. 可以做哪些印刷方式，最大印刷面积是多少 cm？
7. 出口包装是彩盒、白盒还是 opp 袋？
麻烦发一份规格表，谢谢！`
    void navigator.clipboard.writeText(msg).then(
      () => toast.success('话术已复制，直接粘贴发给 1688 客服'),
      () => toast.error('复制失败，请手动复制')
    )
  }

  const exportCsv = () => {
    if (!items.length) return
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const head = ['序号', '标题', '链接', '状态', '缺失字段', '评分', '结论', '采购价', '箱规(cm)', '每箱数', '箱毛重', '产品ID', '错误']
    const lines = [head.map(esc).join(',')]
    for (const it of items) {
      const s = it.source
      lines.push(
        [
          it.idx,
          it.title ?? '',
          it.url,
          ITEM_STATUS[it.status]?.label ?? it.status,
          (it.missing ?? []).join('/'),
          it.score ?? '',
          it.verdict ?? '',
          s?.priceCny ?? '',
          [s?.cartonLCm, s?.cartonWCm, s?.cartonHCm].filter(Boolean).join('x'),
          s?.pcsPerCarton ?? '',
          s?.cartonGwKg ?? '',
          it.productId ?? '',
          it.error ?? '',
        ]
          .map(esc)
          .join(',')
      )
    }
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `batch-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const openJob = (id: string) => {
    setJobId(id)
    setJob(null)
    setEditingIdx(null)
    localStorage.setItem(JOB_KEY, id)
    setNonce((n) => n + 1)
  }

  const visibleItems = onlyMissing ? items.filter((i) => (i.missing?.length ?? 0) > 0) : items
  const failedCount = items.filter((i) => i.status === 'error').length

  return (
    <div className="space-y-4">
      {/* ① 输入 */}
      <SectionCard
        title="① 批量输入产品"
        hint="每行一个产品。第一行有表头会自动识别列，列的顺序无所谓 —— 图片可以放最前面。图片一格能写多张（空格或、分隔），也可以留空：命中产品资料库时会自动带图。"
        right={
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-600">
            {text.split('\n').filter((l) => l.trim()).length} 行
          </Badge>
        }
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={`把 1688 商品链接一行一个粘进来，例如：\n${SAMPLE}`}
          className="w-full resize-y rounded-lg border border-slate-200 bg-slate-50/60 p-3 font-mono text-[12px] leading-relaxed text-slate-800 outline-none focus:border-blue-400 focus:bg-white"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setText(SAMPLE)}>
            <ClipboardPaste className="mr-1 h-3.5 w-3.5" /> 填入示例
          </Button>
          {text.trim() && (
            <Button variant="ghost" size="sm" className="text-slate-500" onClick={() => setText('')}>
              <Trash2 className="mr-1 h-3.5 w-3.5" /> 清空
            </Button>
          )}
          <Button onClick={() => void start()} disabled={creating || isRunning} size="sm">
            {creating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Layers className="mr-1 h-3.5 w-3.5" />}
            建立批次
          </Button>
          <span className="text-[11px] text-slate-400">
            以 # 开头当注释；同一批重复链接只跑一次；单批最多 50 条
          </span>
        </div>

        {/* 图片怎么来的三种情况，直接写清楚，省得来回猜 */}
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
          <span className="font-medium text-slate-700">图片从哪来？</span>{' '}
          ① 资料库里有的链接，预填时自动带图（推荐：先导一次资料库）；
          ② 表格里加一列「图片」，填网址（多张用空格/、分隔）；
          ③ 建批次后，在表格里点「补全 → 上传本地图」逐条加。
          <span className="text-amber-700">　从 1688 链接实时抓图不可靠</span>（对方反爬，服务器侧基本拿不到），别指望这条路。
        </div>
      </SectionCard>

      {/* ② 阶段推进 */}
      {job && (
        <SectionCard
          title="② 分阶段处理"
          hint="顺序和单品页一致：抓取 → 补全（箱规等 1688 抓不到的字段必须你填）→ 评估 → 入库"
          right={
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={JOB_STATUS[job.status]?.cls}>
                {JOB_STATUS[job.status]?.label ?? job.status}
              </Badge>
              <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-600">
                {PHASE_LABEL[job.phase]}
              </Badge>
            </div>
          }
        >
          {/* 步骤条 */}
          <div className="flex flex-wrap items-center gap-1.5">
            {STEPS.map((s, i) => {
              const active = phaseStep(job.phase) === i
              const done = phaseStep(job.phase) > i
              return (
                <div
                  key={s.key}
                  className={[
                    'rounded-full border px-2.5 py-1 text-[11px]',
                    active
                      ? 'border-blue-300 bg-blue-50 font-semibold text-blue-700'
                      : done
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-slate-200 bg-white text-slate-400',
                  ].join(' ')}
                >
                  {done && <Check className="mr-1 inline h-3 w-3" />}
                  {s.label}
                </div>
              )
            })}
          </div>

          {/* 阶段按钮：每个都能单独点，已完成/不满足条件的自动跳过 */}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StageBtn
              label="① 信息预填"
              count={stageCounts.fetch}
              hint="抓 1688 / 命中资料库"
              disabled={isRunning || stageCounts.fetch === 0}
              onClick={() => void run('fetch')}
            />
            <StageBtn
              label="② 人工补全"
              count={stats.missing}
              hint="逐条填箱规等抓不到的字段"
              disabled={isRunning || stats.missing === 0}
              onClick={() => {
                setOnlyMissing(true)
                toast.info('点表格里每条右侧的「补全」逐条填，填完点保存')
              }}
            />
            <StageBtn
              label="③ 选品预估"
              count={stageCounts.quick}
              hint="字段不全也能先粗评一版"
              disabled={isRunning || stageCounts.quick === 0}
              onClick={() => void run('quick')}
            />
            <StageBtn
              label="④ AI 评估"
              count={stageCounts.evaluate}
              hint="正式评分，结果同时进评估库"
              disabled={isRunning || stageCounts.evaluate === 0}
              onClick={() => void run('evaluate')}
            />
            <StageBtn
              label="⑤ 生成英文链接"
              count={stageCounts.listing}
              hint="进待审核库，不直接进产品库"
              disabled={isRunning || stageCounts.listing === 0}
              onClick={() => void run('listing')}
            />
            <StageBtn
              label="⑥ 入库产品库"
              count={stageCounts.save}
              hint="审核通过的才会真进产品库"
              disabled={isRunning || stageCounts.save === 0}
              onClick={() => void run('save')}
            />
          </div>

          {/* 运行控制 */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {isRunning && (
              <Button size="sm" variant="outline" onClick={() => void pause()}>
                <Pause className="mr-1 h-3.5 w-3.5" /> 暂停
              </Button>
            )}
            {(job.status === 'paused' || job.status === 'interrupted') && (
              <Button size="sm" onClick={() => void resume()}>
                <Play className="mr-1 h-3.5 w-3.5" />{' '}
                {job.lastStage ? `继续（${STAGE_LABEL[job.lastStage]}）` : '继续上次进度'}
              </Button>
            )}
            {(isRunning || job.status === 'paused' || job.status === 'interrupted') && (
              <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => void stop()}>
                <Square className="mr-1 h-3.5 w-3.5" /> 停止
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={isRunning}
              onClick={() => void run('all')}
              title="跳过人工补全，抓完直接评估 → 生成链接（缺的字段按默认值算，分数会不准）；跑的过程中可以随时暂停"
            >
              <Wand2 className="mr-1 h-3.5 w-3.5" /> 一键全流程（跳过补全）
            </Button>
            {failedCount > 0 && !isRunning && (
              <Button variant="outline" size="sm" onClick={() => void retry()}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" /> 重试失败项（{failedCount}）
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!items.length}>
              <Download className="mr-1 h-3.5 w-3.5" /> 导出结果
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-orange-200 text-orange-700"
              onClick={() => navigate('/listing-reviews')}
            >
              <ClipboardCheck className="mr-1 h-3.5 w-3.5" />
              英文链接待审核（{reviewPending}）
            </Button>
          </div>

          {/* 缺字段提醒：这才是「预填」不能省的原因 */}
          {job.phase === 'fetched' && stats.missing > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="min-w-0 text-[12px] leading-relaxed text-amber-800">
                <div className="font-medium">
                  还有 {stats.missing} 条缺关键字段（{Array.from(new Set(items.flatMap((i) => i.missing ?? []))).join('、')}）
                </div>
                <div className="mt-0.5 text-amber-700">
                  1688 抓不到箱规、每箱数、箱毛重。这些字段决定运费和阶梯报价，缺了只能按默认值估算，分数会骗人。
                  点表格里的「编辑 / 补全」逐条填，客服不给就问一句（下面每条都能复制话术）。
                </div>
                <div className="mt-1.5">
                  <Button size="sm" variant="outline" onClick={() => setOnlyMissing(true)}>
                    只看缺字段的 {stats.missing} 条
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[12px] text-slate-600">
              共 {stats.total} 条 · 已抓取 {stats.fetched} · 已评估 {stats.evaluated} · 已入库 {stats.saved}
              {stats.failed > 0 && <span className="text-rose-600"> · 失败 {stats.failed}</span>}
            </div>
            <div className="flex items-center gap-2">
              {selected.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-rose-600"
                  disabled={deleting || isRunning}
                  onClick={() => void deleteSelected()}
                >
                  {deleting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
                  删除选中（{selected.length}）
                </Button>
              )}
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600">
                <Checkbox checked={onlyMissing} onCheckedChange={(v) => setOnlyMissing(Boolean(v))} />
                只看缺字段的
              </label>
            </div>
          </div>
          <Progress
            value={stats.total ? Math.round((stats.saved / stats.total) * 100) : 0}
            className="mt-1.5 h-2"
          />

          {/* 表格 */}
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-[12px]">
              <thead className="text-[11px] text-slate-400">
                <tr className="border-b border-slate-100">
                  <th className="w-8 py-2 pr-2 font-medium">
                    <Checkbox
                      checked={visibleItems.length > 0 && visibleItems.every((i) => selected.includes(i.idx))}
                      onCheckedChange={(v) => {
                        if (v) setSelected(visibleItems.map((i) => i.idx))
                        else setSelected([])
                      }}
                      title="全选"
                    />
                  </th>
                  <th className="py-2 pr-2 font-medium">#</th>
                  <th className="py-2 pr-2 font-medium">产品</th>
                  <th className="py-2 pr-2 font-medium">图</th>
                  <th className="py-2 pr-2 font-medium">状态</th>
                  <th className="py-2 pr-2 font-medium">缺什么</th>
                  <th className="py-2 pr-2 font-medium">评分</th>
                  <th className="py-2 pr-2 font-medium">结果 / 提示</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((it) => (
                  <ItemRow
                    key={it.idx}
                    item={it}
                    running={isRunning}
                    editing={editingIdx === it.idx}
                    draft={draft}
                    setDraft={setDraft}
                    savingEdit={savingEdit}
                    saveError={editingIdx === it.idx ? saveError : ''}
                    selected={selected.includes(it.idx)}
                    grabbingImages={grabbingImages}
                    onToggleSelect={() => toggleSelect(it.idx)}
                    onGrabImages={() => void grabImages(it.url)}
                    onEdit={() => openEdit(it)}
                    onCancel={() => {
                      setEditingIdx(null)
                      setSaveError('')
                    }}
                    onSave={() => void saveEdit(false)}
                    onSaveEvaluate={() => void saveEdit(true)}
                    onEvaluate={() => void run('evaluate', [it.idx])}
                    onSaveOne={() => void run('save', [it.idx])}
                    onCopyAsk={() => copyAskSupplier(it)}
                    onOpenProduct={() => it.productId && navigate(`/listing/${it.productId}`)}
                  />
                ))}
              </tbody>
            </table>
            {visibleItems.length === 0 && (
              <div className="py-6 text-center text-[12px] text-slate-400">
                没有符合条件的条目
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* ③ 历史 */}
      {recent.length > 0 && (
        <SectionCard title="最近批次" hint="批次存在云库里，换浏览器/刷新页面都能接着填">
          <div className="divide-y divide-slate-100">
            {recent.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="outline" className={JOB_STATUS[j.status]?.cls}>
                    {JOB_STATUS[j.status]?.label ?? j.status}
                  </Badge>
                  <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-600">
                    {PHASE_LABEL[j.phase]}
                  </Badge>
                  <span className="truncate text-[12px] text-slate-700">
                    {j.total} 条 · 已抓 {j.fetched} · 已评 {j.evaluated} · 已入库 {j.done}
                    {j.missing > 0 ? ` · 缺字段 ${j.missing}` : ''}
                    {j.failed > 0 ? ` · 失败 ${j.failed}` : ''}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-400">
                    {new Date(j.createdAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => openJob(j.id)}>
                  打开
                </Button>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {!job && recent.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center">
          <Layers className="mx-auto h-9 w-9 text-slate-300" />
          <p className="mt-3 text-sm font-medium text-slate-600">还没有批次</p>
          <p className="mt-1 text-xs text-slate-400">
            上面粘一批 1688 链接 → 「建立批次」→ 「① 抓取资料」→ 补全箱规 → 评估 → 入库
          </p>
        </div>
      )}
    </div>
  )
}

function ItemRow({
  item,
  running,
  editing,
  draft,
  setDraft,
  savingEdit,
  saveError,
  selected,
  grabbingImages,
  onToggleSelect,
  onGrabImages,
  onEdit,
  onCancel,
  onSave,
  onSaveEvaluate,
  onEvaluate,
  onSaveOne,
  onCopyAsk,
  onOpenProduct,
}: {
  item: BatchItem
  running: boolean
  editing: boolean
  draft: BatchItemInput
  setDraft: (v: BatchItemInput) => void
  savingEdit: boolean
  saveError: string
  selected: boolean
  grabbingImages: boolean
  onToggleSelect: () => void
  onGrabImages: () => void
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
  onSaveEvaluate: () => void
  onEvaluate: () => void
  onSaveOne: () => void
  onCopyAsk: () => void
  onOpenProduct: () => void
}) {
  const meta = ITEM_STATUS[item.status] ?? ITEM_STATUS.pending
  const active = ['fetching', 'evaluating', 'saving', 'listing'].includes(item.status)
  const missing = item.missing ?? []
  const canEdit = !running && item.status !== 'done'

  // 补全时加图：1688 抓不到的情况下（几乎总是抓不到），直接传本地图最省事
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploadingImages, setUploadingImages] = useState(false)
  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setUploadingImages(true)
    try {
      const urls: string[] = []
      for (const f of Array.from(files).slice(0, 8)) {
        try {
          urls.push(await fileToDataUrl(f))
        } catch {
          /* 单张读不出来不影响其他张 */
        }
      }
      if (!urls.length) {
        toast.error('这几张图读不出来，换一张试试')
        return
      }
      setDraft({
        ...draft,
        images: Array.from(new Set([...(draft.images ?? []), ...urls])).slice(0, 8),
      })
      toast.success(`已加 ${urls.length} 张图，记得点「保存」`)
    } finally {
      setUploadingImages(false)
    }
  }

  return (
    <>
      <tr className="border-b border-slate-50 align-top">
        <td className="py-2 pr-2">
          <Checkbox checked={selected} onCheckedChange={onToggleSelect} />
        </td>
        <td className="py-2 pr-2 text-slate-400">{item.idx}</td>
        <td className="max-w-[240px] py-2 pr-2">
          <div className="truncate font-medium text-slate-800" title={item.title ?? item.url}>
            {item.title || item.url || '（手动录入）'}
          </div>
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate text-[11px] text-blue-600 hover:underline"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="truncate">{item.url.replace(/^https?:\/\//, '')}</span>
            </a>
          )}
        </td>
        <td className="py-2 pr-2">
          <ImageStack images={item.source?.images ?? []} />
        </td>
        <td className="py-2 pr-2">
          <Badge variant="outline" className={meta.cls}>
            {active && <Loader2 className="mr-0.5 h-3 w-3 animate-spin" />}
            {meta.label}
          </Badge>
        </td>
        <td className="max-w-[150px] py-2 pr-2">
          {missing.length ? (
            <div className="flex flex-wrap gap-1">
              {missing.map((m) => (
                <span
                  key={m}
                  className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 ring-1 ring-amber-200"
                >
                  {m}
                </span>
              ))}
            </div>
          ) : item.source ? (
            <span className="text-[11px] text-emerald-600">齐全</span>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
        <td className="py-2 pr-2">
          {typeof item.score === 'number' ? (
            <VerdictBadge verdict={(item.verdict as 'GO' | 'MAYBE' | 'NO' | null) ?? null} score={item.score} />
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
        <td className="max-w-[260px] py-2 pr-2">
          <div className="text-[11px] text-slate-500">{item.stage}</div>
          {item.marketNote && <div className="mt-0.5 text-[11px] text-slate-500">{item.marketNote}</div>}
          {item.warn && (
            <div className="mt-0.5 flex items-start gap-1 text-[11px] text-amber-600">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{item.warn}</span>
            </div>
          )}
          {item.error && <div className="mt-0.5 text-[11px] leading-relaxed text-rose-600">{item.error}</div>}
        </td>
        <td className="py-2">
          <div className="flex flex-wrap items-center gap-1">
            {canEdit && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={editing ? onCancel : onEdit}>
                <Pencil className="mr-0.5 h-3 w-3" />
                {editing ? '收起' : missing.length ? '补全' : '编辑'}
              </Button>
            )}
            {!running && !item.evaluated && !item.productId && item.status !== 'error' && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onEvaluate}>
                评估本条
              </Button>
            )}
            {!running && item.evaluated && !item.productId && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onSaveOne}>
                入库本条
              </Button>
            )}
            {item.productId && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onOpenProduct}>
                生成链接
              </Button>
            )}
          </div>
        </td>
      </tr>

      {editing && (
        <tr className="border-b border-slate-100 bg-slate-50/60">
          <td />
          <td colSpan={8} className="py-3 pr-2">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="商品标题" full>
                <input
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  value={draft.title ?? ''}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </Field>
              <Field label="采购价（元）" warn={fieldMissing(item.source, 'priceCny')}>
                <input
                  type="number"
                  step="0.01"
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  value={draft.priceCny ?? ''}
                  onChange={(e) => setDraft({ ...draft, priceCny: numberOrNull(e.target.value) })}
                />
              </Field>
              <Field label="MOQ（起订量）">
                <input
                  type="number"
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  value={draft.moq ?? ''}
                  onChange={(e) => setDraft({ ...draft, moq: numberOrNull(e.target.value) })}
                />
              </Field>
              <Field label="单件重（g）">
                <input
                  type="number"
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  value={draft.weightG ?? ''}
                  onChange={(e) => setDraft({ ...draft, weightG: numberOrNull(e.target.value) })}
                />
              </Field>
              <Field label="产品尺寸" warn={fieldMissing(item.source, 'sizeCn')}>
                <input
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  placeholder="20x15x8cm"
                  value={draft.sizeCn ?? ''}
                  onChange={(e) => setDraft({ ...draft, sizeCn: e.target.value })}
                />
              </Field>
              <Field label="材质" warn={fieldMissing(item.source, 'materialCn')}>
                <input
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  value={draft.materialCn ?? ''}
                  onChange={(e) => setDraft({ ...draft, materialCn: e.target.value })}
                />
              </Field>
              <Field label="颜色">
                <input
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  value={draft.colorsCn ?? ''}
                  onChange={(e) => setDraft({ ...draft, colorsCn: e.target.value })}
                />
              </Field>
              <Field label="箱规 长（cm）" warn={cartonMissing(item.source)}>
                <input
                  type="number"
                  step="0.1"
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  value={draft.cartonLCm ?? ''}
                  onChange={(e) => setDraft({ ...draft, cartonLCm: numberOrNull(e.target.value) })}
                />
              </Field>
              <Field label="箱规 宽（cm）" warn={cartonMissing(item.source)}>
                <input
                  type="number"
                  step="0.1"
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  value={draft.cartonWCm ?? ''}
                  onChange={(e) => setDraft({ ...draft, cartonWCm: numberOrNull(e.target.value) })}
                />
              </Field>
              <Field label="箱规 高（cm）" warn={cartonMissing(item.source)}>
                <input
                  type="number"
                  step="0.1"
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  value={draft.cartonHCm ?? ''}
                  onChange={(e) => setDraft({ ...draft, cartonHCm: numberOrNull(e.target.value) })}
                />
              </Field>
              <Field label="每箱数量" warn={fieldMissing(item.source, 'pcsPerCarton')}>
                <input
                  type="number"
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  value={draft.pcsPerCarton ?? ''}
                  onChange={(e) => setDraft({ ...draft, pcsPerCarton: numberOrNull(e.target.value) })}
                />
              </Field>
              <Field label="整箱毛重（kg）" warn={fieldMissing(item.source, 'cartonGwKg')}>
                <input
                  type="number"
                  step="0.01"
                  className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  value={draft.cartonGwKg ?? ''}
                  onChange={(e) => setDraft({ ...draft, cartonGwKg: numberOrNull(e.target.value) })}
                />
              </Field>
              <Field label="1688 描述 / 备注" full>
                <textarea
                  rows={2}
                  className="w-full rounded border border-slate-200 px-2 py-1 text-[12px]"
                  value={draft.description ?? ''}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </Field>
              {/* 产品图：出图时作为参考图，评估时也能帮 AI 认品类 */}
              <Field label={`产品图片（${(draft.images ?? []).length}/8）`} full>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={onGrabImages} disabled={grabbingImages}>
                    {grabbingImages ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ImagePlus className="mr-1 h-3.5 w-3.5" />
                    )}
                    从 1688 抓图
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      void pickFiles(e.target.files)
                      e.target.value = ''
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={uploadingImages}
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploadingImages ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ImagePlus className="mr-1 h-3.5 w-3.5" />
                    )}
                    上传本地图
                  </Button>
                  <input
                    className="h-7 w-64 rounded border border-slate-200 px-2 text-[11px]"
                    placeholder="粘贴图片地址后回车添加"
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      const v = (e.target as HTMLInputElement).value.trim()
                      if (!/^https?:\/\//i.test(v)) return
                      setDraft({
                        ...draft,
                        images: Array.from(new Set([...(draft.images ?? []), v])).slice(0, 8),
                      })
                      ;(e.target as HTMLInputElement).value = ''
                    }}
                  />
                  {(draft.images ?? []).length === 0 && (
                    <span className="text-[11px] text-amber-600">没有图，出图只能凭空画，容易走形</span>
                  )}
                </div>
                {(draft.images ?? []).length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {(draft.images ?? []).map((u, i) => (
                      <div key={`${u}-${i}`} className="group relative h-14 w-14 overflow-hidden rounded border border-slate-200">
                        <img src={u} alt="" className="h-full w-full object-cover" />
                        <button
                          type="button"
                          className="absolute right-0 top-0 hidden rounded-bl bg-black/60 px-1 text-[10px] text-white group-hover:block"
                          onClick={() =>
                            setDraft({ ...draft, images: (draft.images ?? []).filter((_, idx) => idx !== i) })
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Field>
            </div>
            {saveError && (
              <div className="mt-2 flex items-start gap-1.5 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] leading-relaxed text-rose-700">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>保存失败：{saveError}</span>
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={onSave} disabled={savingEdit}>
                {savingEdit ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                保存
              </Button>
              <Button size="sm" variant="outline" onClick={onSaveEvaluate} disabled={savingEdit}>
                保存并评估本条
              </Button>
              <Button size="sm" variant="ghost" onClick={onCopyAsk}>
                复制问商家话术
              </Button>
              <Button size="sm" variant="ghost" className="text-slate-500" onClick={onCancel}>
                <X className="mr-1 h-3.5 w-3.5" /> 取消
              </Button>
              {item.evaluated && (
                <span className="text-[11px] text-amber-600">改动保存后，现有的评估会作废，需要重新评估</span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Field({
  label,
  warn,
  full,
  children,
}: {
  label: string
  warn?: boolean
  full?: boolean
  children: React.ReactNode
}) {
  return (
    <label className={full ? 'sm:col-span-2 lg:col-span-3' : ''}>
      <span className={`mb-0.5 flex items-center gap-1 text-[11px] ${warn ? 'font-medium text-amber-700' : 'text-slate-500'}`}>
        {label}
        {warn && <span className="rounded bg-amber-100 px-1 text-[10px]">缺</span>}
      </span>
      {children}
    </label>
  )
}
