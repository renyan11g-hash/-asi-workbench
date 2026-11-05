import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Check,
  ClipboardPaste,
  Download,
  ExternalLink,
  ImagePlus,
  Layers,
  Loader2,
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
  SourceInfo,
} from '@/types'

const JOB_KEY = 'asi-batch:jobId'

const ITEM_STATUS: Record<BatchItemStatus, { label: string; cls: string }> = {
  pending: { label: '待抓取', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  fetching: { label: '抓取中', cls: 'bg-sky-100 text-sky-700 border-sky-200' },
  fetched: { label: '待补全', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  evaluating: { label: '评估中', cls: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  evaluated: { label: '已评估', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  saving: { label: '入库中', cls: 'bg-violet-100 text-violet-700 border-violet-200' },
  listing: { label: '生成链接', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  done: { label: '已入库', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  error: { label: '失败', cls: 'bg-rose-100 text-rose-600 border-rose-200' },
  skipped: { label: '跳过', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
}

const JOB_STATUS: Record<BatchJobStatus, { label: string; cls: string }> = {
  draft: { label: '待处理', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  running: { label: '处理中', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  done: { label: '已停', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  cancelled: { label: '已停止', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  interrupted: { label: '已中断', cls: 'bg-rose-100 text-rose-600 border-rose-200' },
}

const PHASE_LABEL: Record<BatchPhase, string> = {
  draft: '待抓取',
  fetched: '已抓取 · 待补全',
  evaluated: '已评估 · 待入库',
  saved: '已入库',
}

const STEPS: Array<{ key: BatchPhase | 'fill'; label: string }> = [
  { key: 'draft', label: '① 抓取资料' },
  { key: 'fill', label: '② 补全信息' },
  { key: 'evaluated', label: '③ AI 评估' },
  { key: 'saved', label: '④ 入库' },
]

function phaseStep(phase: BatchPhase): number {
  return phase === 'draft' ? 0 : phase === 'fetched' ? 1 : phase === 'evaluated' ? 2 : 3
}

const DEFAULT_OPTIONS: BatchOptions = { fetch: true, evaluate: true, save: true, listing: false }

const SAMPLE = `链接	标题	采购价	MOQ	尺寸	材质	颜色	箱规	每箱数	箱毛重
https://detail.1688.com/offer/123456789.html	折叠收纳盒	3.5	100	20x15x8cm	PU皮	黑/灰	40x30x25	60	12
https://detail.1688.com/offer/123456790.html	硅胶杯托	2.8	200	12x12x3cm	硅胶	三色	45x35x30	120	9`

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
 * 批量处理：粘贴多条产品 → 抓取 → **人工补全（箱规等 1688 抓不到的字段）** → 评估 → 入库。
 *
 * 刻意不在这里做任何新的业务判断：每一步都调用单品流程的服务端函数，
 * 所以评分/印刷方式/报价/市场探针与单品完全一致，这里只负责排队、补全和展示进度。
 */
export default function Batch() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [options, setOptions] = useState<BatchOptions>(DEFAULT_OPTIONS)
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
  const [onlyMissing, setOnlyMissing] = useState(false)
  /** 勾选的条目 idx（用于批量删除） */
  const [selected, setSelected] = useState<number[]>([])
  const [deleting, setDeleting] = useState(false)
  const [grabbingImages, setGrabbingImages] = useState(false)

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

  const run = async (stage: 'fetch' | 'evaluate' | 'save' | 'all', idxs?: number[]) => {
    if (!jobId) return
    try {
      await api.runBatchStage(jobId, stage, idxs)
      setNonce((n) => n + 1)
      const label =
        stage === 'fetch'
          ? '开始抓取资料，抓完会停下来等补全'
          : stage === 'evaluate'
            ? '开始批量评估（不落库，先看分）'
            : stage === 'save'
              ? '开始入库'
              : '一键跑完（跳过人工补全）'
      toast.success(label)
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
    try {
      const j = await api.patchBatchItem(jobId, idx, draft)
      setJob(j)
      setEditingIdx(null)
      if (thenEvaluate) {
        await api.runBatchStage(jobId, 'evaluate', [idx])
        setNonce((n) => n + 1)
        toast.success(`第 ${idx} 条已保存并开始评估`)
      } else {
        toast.success(`第 ${idx} 条资料已保存`)
      }
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSavingEdit(false)
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

  /** 主按钮跟着阶段走：抓取 → (补全) → 评估 → 入库 */
  const primary = (() => {
    if (!job) return null
    if (isRunning) return { label: '处理中…', stage: null as null, disabled: true, hint: '' }
    if (job.phase === 'draft') {
      return {
        label: `① 抓取资料（${items.filter((i) => i.url && !i.source).length} 条）`,
        stage: 'fetch' as const,
        disabled: false,
        hint: '抓完会停下来，等你补全箱规等 1688 抓不到的字段',
      }
    }
    if (job.phase === 'fetched') {
      return {
        label: `③ 批量评估（${stats.canEval} 条）`,
        stage: 'evaluate' as const,
        disabled: stats.canEval === 0,
        hint: '评估不落库，先看分数；补全资料可以随时改',
      }
    }
    if (job.phase === 'evaluated') {
      return {
        label: `④ 入库（${stats.evaluated - stats.saved} 条）`,
        stage: 'save' as const,
        disabled: stats.evaluated - stats.saved <= 0,
        hint: '入库后在产品库里能看到，再进链接生成页微调',
      }
    }
    return {
      label: '已全部入库',
      stage: null as null,
      disabled: true,
      hint: '这一批已经进产品库了',
    }
  })()

  return (
    <div className="space-y-4">
      {/* ① 输入 */}
      <SectionCard
        title="① 批量输入产品"
        hint="每行一个产品。只粘贴 1688 链接就能跑；从 Excel 复制多列也行（顺序：链接 / 标题 / 采购价 / MOQ / 尺寸 / 材质 / 颜色 / 箱规 / 每箱数 / 箱毛重 / 单件重 / 备注），第一行有表头会自动识别"
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
          <label className="ml-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600">
            <Checkbox
              checked={options.listing}
              onCheckedChange={(v) => setOptions((o) => ({ ...o, listing: Boolean(v) }))}
            />
            入库时顺便生成英文 listing（每条多约 1 分钟）
          </label>
          <Button onClick={() => void start()} disabled={creating || isRunning} size="sm">
            {creating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Layers className="mr-1 h-3.5 w-3.5" />}
            建立批次
          </Button>
          <span className="text-[11px] text-slate-400">
            以 # 开头当注释；同一批重复链接只跑一次；单批最多 50 条
          </span>
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

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {primary && (
              <Button
                onClick={() => primary.stage && void run(primary.stage)}
                disabled={primary.disabled || isRunning}
              >
                {isRunning ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-1.5 h-4 w-4" />
                )}
                {primary.label}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={isRunning}
              onClick={() => void run('all')}
              title="跳过人工补全，抓完直接评估入库（缺的字段按默认值算，分数会不准）"
            >
              <Wand2 className="mr-1 h-3.5 w-3.5" /> 一键跑完
            </Button>
            {isRunning && (
              <Button variant="outline" size="sm" onClick={() => void stop()}>
                <Square className="mr-1 h-3.5 w-3.5" /> 停止
              </Button>
            )}
            {failedCount > 0 && !isRunning && (
              <Button variant="outline" size="sm" onClick={() => void retry()}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" /> 重试失败项（{failedCount}）
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!items.length}>
              <Download className="mr-1 h-3.5 w-3.5" /> 导出结果
            </Button>
            {primary?.hint && <span className="text-[11px] text-slate-500">{primary.hint}</span>}
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
                    selected={selected.includes(it.idx)}
                    grabbingImages={grabbingImages}
                    onToggleSelect={() => toggleSelect(it.idx)}
                    onGrabImages={() => void grabImages(it.url)}
                    onEdit={() => openEdit(it)}
                    onCancel={() => setEditingIdx(null)}
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
          <td colSpan={7} className="py-3 pr-2">
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
