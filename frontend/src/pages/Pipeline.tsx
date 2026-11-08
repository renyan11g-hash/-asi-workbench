import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  ImageIcon,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { FlowNextStep, FlowRow } from '@/types'

/** 下一步的中文说法 + 按钮文案（整条流水线只有这一套口径） */
const NEXT_TEXT: Record<FlowNextStep, { label: string; action: string }> = {
  specs: { label: '待补资料', action: '补资料' },
  evaluate: { label: '待评估', action: '去评估' },
  evalReview: { label: '待定评估结论', action: '审核评估' },
  parked: { label: '待定', action: '看评估' },
  listing: { label: '待生成文案', action: '生成英文链接' },
  confirm: { label: '待确认保存', action: '核对保存' },
  review: { label: '待审核', action: '审核' },
  done: { label: '已完成', action: '查看' },
  rejected: { label: '已驳回', action: '改后重做' },
  trashed: { label: '回收站', action: '查看' },
}

const NEXT_STYLE: Record<FlowNextStep, string> = {
  specs: 'bg-amber-100 text-amber-800 border-amber-200',
  evaluate: 'bg-sky-100 text-sky-800 border-sky-200',
  evalReview: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200',
  parked: 'bg-slate-200 text-slate-600 border-slate-300',
  listing: 'bg-violet-100 text-violet-800 border-violet-200',
  confirm: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  review: 'bg-rose-100 text-rose-800 border-rose-200',
  done: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  rejected: 'bg-slate-200 text-slate-700 border-slate-300',
  trashed: 'bg-slate-200 text-slate-600 border-slate-300',
}

const FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'specs', label: '待补资料' },
  { value: 'evaluate', label: '待评估' },
  { value: 'evalReview', label: '待定评估结论' },
  { value: 'parked', label: '待定' },
  { value: 'listing', label: '待生成文案' },
  { value: 'review', label: '待审核' },
  { value: 'done', label: '已完成' },
  { value: 'rejected', label: '已驳回' },
]

/** 有英文文案可审核/可确认、或可以直接批量出文案的那些 */
function canBatchListing(r: FlowRow): boolean {
  return r.hasEval && (r.nextStep === 'listing' || r.nextStep === 'confirm')
}

function StepDot({ done, label }: { done: boolean; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
        done ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
      )}
      title={label}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', done ? 'bg-emerald-500' : 'bg-slate-300')} />
      {label}
    </span>
  )
}

/**
 * 产品流水线：整个系统的核心一页。
 *
 * 以前一个产品要在「选品预估 → 产品信息预填 → 评估库 → 生成链接 → 待审核 → 产品库」
 * 之间手动接力，靠人记住每条跑到哪一步。这一页把**同一份产品档案**的每一步进度摊开：
 * 资料齐不齐、评没评估、有没有英文文案、出了几张图、现在什么状态、下一步该点哪。
 */
export default function Pipeline() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [need, setNeed] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [working, setWorking] = useState(false)
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null)

  const overviewQuery = useQuery({
    queryKey: ['flow-overview'],
    queryFn: api.getFlowOverview,
    refetchInterval: 15_000,
  })
  const listQuery = useQuery({
    queryKey: ['flow-products', need],
    queryFn: () => api.listFlowProducts({ need }),
    // 后台在跑评估/生成时，这一页自己会更新，不用手动刷新
    refetchInterval: 15_000,
  })

  const overview = overviewQuery.data
  const rows = useMemo(() => {
    const list = listQuery.data?.rows ?? []
    const k = keyword.trim().toLowerCase()
    if (!k) return list
    return list.filter(
      (r) =>
        r.title.toLowerCase().includes(k) ||
        r.titleEn.toLowerCase().includes(k) ||
        r.code.toLowerCase().includes(k) ||
        r.sourceUrl.toLowerCase().includes(k)
    )
  }, [listQuery.data, keyword])

  const selectedRows = rows.filter((r) => selected.includes(r.id))
  const batchable = selectedRows.filter(canBatchListing)

  const toggle = (id: string) => {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  /** 批量出英文文案：直接读产品档案，不再重新粘链接、不再重新补资料 */
  const runBatchListing = async () => {
    const ids = batchable.map((r) => r.id)
    if (!ids.length) {
      toast.error('选中的产品里没有「已评估、待生成文案」的条目')
      return
    }
    setWorking(true)
    try {
      const { job, skipped } = await api.createBatchFromProducts(ids)
      await api.runBatchStage(job.id, 'listing')
      localStorage.setItem('asi-batch:jobId', job.id)
      qc.invalidateQueries({ queryKey: ['flow-overview'] })
      qc.invalidateQueries({ queryKey: ['flow-products'] })
      if (skipped.length) {
        toast.warning(`已载入 ${ids.length - skipped.length} 条，跳过 ${skipped.length} 条：${skipped[0].reason}`)
      } else {
        toast.success(`已开始为 ${ids.length} 个产品生成英文文案`)
      }
      navigate('/batch')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setWorking(false)
    }
  }

  /** 单条评估：直接对这一条档案跑一次完整 AI 评估（和单品页同一个接口） */
  const evaluateOne = async (row: FlowRow) => {
    setEvaluatingId(row.id)
    try {
      await api.evaluateProduct(row.id)
      toast.success(`${row.code} 已重新评估`)
      qc.invalidateQueries({ queryKey: ['flow-overview'] })
      qc.invalidateQueries({ queryKey: ['flow-products'] })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setEvaluatingId(null)
    }
  }

  /** 批量评估：资料齐了的产品，一次排队跑完 AI 评估（含看图找同款） */
  const runBatchEvaluate = async () => {
    const ids = selectedRows.filter((r) => r.nextStep === 'evaluate' || r.nextStep === 'specs').map((r) => r.id)
    if (!ids.length) {
      toast.error('选中的产品里没有「待评估」的条目')
      return
    }
    setWorking(true)
    try {
      const { job, skipped } = await api.evaluateProducts({
        productIds: ids.slice(0, 20),
        clientKey: `eval-${Date.now()}`,
      })
      localStorage.setItem('asi-production:jobId', job.id)
      qc.invalidateQueries({ queryKey: ['flow-overview'] })
      qc.invalidateQueries({ queryKey: ['flow-products'] })
      if (skipped.length) toast.warning(`已提交 ${job.items.length} 条，跳过 ${skipped.length} 条`)
      else toast.success(`已开始评估 ${job.items.length} 个产品（含看图找同款），跑完在评估库等你审`)
      navigate('/production')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setWorking(false)
    }
  }

  /** 评估审核：通过 → 自动排队生成英文链接；不通过 → 待定 */
  const reviewEvaluation = async (ids: string[], decision: 'approve' | 'reject') => {
    if (!ids.length) return
    if (decision === 'reject' && !window.confirm(`把选中的 ${ids.length} 个产品标成「待定」？（评估结果保留在评估库，可随时改判）`)) return
    setWorking(true)
    try {
      const r = await api.evalReview({ ids, decision })
      qc.invalidateQueries({ queryKey: ['flow-overview'] })
      qc.invalidateQueries({ queryKey: ['flow-products'] })
      if (decision === 'approve') {
        toast.success(`已通过 ${r.changed} 条，正在自动生成英文链接`)
        navigate('/production')
      } else {
        toast.success(`已标为待定 ${r.changed} 条`)
      }
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setWorking(false)
    }
  }

  /** 删除：先移回收站（可恢复），回收站里的再点一次就是永久删除 */
  const removeRow = async (row: FlowRow) => {
    const trashed = row.status === 'trashed'
    if (trashed) {
      if (!window.confirm(`永久删除「${row.code || row.title}」？此操作不可恢复。`)) return
    } else if (!window.confirm(`把「${row.code || row.title}」移进回收站？可在回收站恢复。`)) return
    try {
      const r = await api.deleteProduct(row.id)
      toast.success(trashed || r.action === 'purged' ? '已永久删除' : '已移到回收站')
      setSelected((cur) => cur.filter((x) => x !== row.id))
      qc.invalidateQueries({ queryKey: ['flow-overview'] })
      qc.invalidateQueries({ queryKey: ['flow-products'] })
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const goNext = (row: FlowRow) => {
    if (row.nextStep === 'evaluate' || row.nextStep === 'specs') {
      void evaluateOne(row)
      return
    }
    if (row.nextStep === 'evalReview' || row.nextStep === 'parked') {
      // 直接打开这条的评估详情，而不是只把人丢到评估库首页
      navigate(`/evaluations?open=${row.id}`)
      return
    }
    if (row.nextStep === 'review') {
      navigate('/listing-reviews')
      return
    }
    navigate(`/listing/${row.id}`)
  }

  const counts = overview
  return (
    <div className="space-y-4">
      {/* 漏斗：一眼看出今天该干什么 */}
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-7">
        {[
          { key: 'needSpecs', label: '待补资料', value: counts?.needSpecs ?? 0, filter: 'specs', icon: TriangleAlert, tone: 'text-amber-600' },
          { key: 'needEval', label: '待评估', value: counts?.needEval ?? 0, filter: 'evaluate', icon: Sparkles, tone: 'text-sky-600' },
          { key: 'needEvalReview', label: '待定评估结论', value: counts?.needEvalReview ?? 0, filter: 'evalReview', icon: ClipboardCheck, tone: 'text-fuchsia-600' },
          { key: 'needListing', label: '待生成文案', value: (counts?.needListing ?? 0) + (counts?.needConfirm ?? 0), filter: 'listing', icon: FileText, tone: 'text-violet-600' },
          { key: 'pendingReview', label: '待审核', value: counts?.pendingReview ?? 0, filter: 'review', icon: ClipboardCheck, tone: 'text-rose-600' },
          { key: 'listed', label: '预产品库', value: counts?.inPreLibrary ?? counts?.listed ?? 0, filter: 'done', icon: CheckCircle2, tone: 'text-emerald-600' },
          { key: 'rpa', label: 'RPA 档案库', value: counts?.inRpaArchive ?? 0, filter: 'rpa', icon: Archive, tone: 'text-indigo-600' },
        ].map((c) => (
          <button
            key={c.key}
            onClick={() => setNeed(c.filter)}
            className={cn(
              'rounded-xl border bg-white p-4 text-left shadow-sm transition-colors hover:border-blue-300',
              need === c.filter ? 'border-blue-400 ring-1 ring-blue-200' : 'border-slate-200'
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">{c.label}</span>
              <c.icon className={cn('h-4 w-4', c.tone)} />
            </div>
            <div className="mt-1.5 text-2xl font-bold tracking-tight">{c.value}</div>
          </button>
        ))}
      </div>

      <SectionCard
        title="产品流水线"
        hint="每个产品只有一条档案（RPA 编号）：资料 → 评估 → 英文文案 → 审核 → 正式产品，都在这条档案上推进"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                qc.invalidateQueries({ queryKey: ['flow-overview'] })
                void listQuery.refetch()
              }}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={working || !selectedRows.some((r) => r.nextStep === 'evaluate' || r.nextStep === 'specs')}
              onClick={() => void runBatchEvaluate()}
            >
              <Sparkles className="mr-1 h-3.5 w-3.5" /> 批量评估
            </Button>
            <Button
              size="sm"
              disabled={working || !selectedRows.some((r) => r.nextStep === 'evalReview')}
              onClick={() =>
                void reviewEvaluation(
                  selectedRows.filter((r) => r.nextStep === 'evalReview').map((r) => r.id),
                  'approve'
                )
              }
            >
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 评估通过（自动生成文案）
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={working || !selectedRows.some((r) => r.nextStep === 'evalReview')}
              onClick={() =>
                void reviewEvaluation(
                  selectedRows.filter((r) => r.nextStep === 'evalReview').map((r) => r.id),
                  'reject'
                )
              }
            >
              标为待定
            </Button>
            <Button size="sm" disabled={working || batchable.length === 0} onClick={() => void runBatchListing()}>
              {working ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Layers className="mr-1 h-3.5 w-3.5" />
              )}
              批量生成英文文案{batchable.length ? `（${batchable.length}）` : ''}
            </Button>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜编号 / 中文名 / 英文标题 / 链接"
              className="h-9 w-72 rounded-md border border-slate-200 pl-8 pr-2 text-sm outline-none focus:border-blue-400"
            />
          </div>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setNeed(f.value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                need === f.value
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              )}
            >
              {f.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-slate-400">
            共 {listQuery.data?.total ?? 0} 条{selected.length ? `，已选 ${selected.length} 条` : ''}
          </span>
        </div>

        {listQuery.isLoading ? (
          <div className="flex items-center justify-center py-16 text-sm text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载产品档案…
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-14 text-center">
            <p className="text-sm font-medium text-slate-600">这里还没有产品档案</p>
            <p className="mt-1 text-xs text-slate-400">
              先去「产品信息预填」粘一条 1688 链接，保存后就会生成一条 RPA 编号的档案
            </p>
            <Button className="mt-4" size="sm" variant="outline" onClick={() => navigate('/sourcing')}>
              <ArrowRight className="mr-1 h-4 w-4" /> 去录入产品
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-separate border-spacing-y-2 text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="w-8 pl-2">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={rows.length > 0 && selected.length === rows.length}
                      onChange={(e) =>
                        setSelected(e.target.checked ? rows.map((r) => r.id) : [])
                      }
                    />
                  </th>
                  <th className="w-24">编号</th>
                  <th>产品</th>
                  <th className="w-44">资料</th>
                  <th className="w-24">AI 评估</th>
                  <th className="w-36">英文文案</th>
                  <th className="w-20">出图</th>
                  <th className="w-28">状态</th>
                  <th className="w-44">下一步</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const thumb = r.images.thumb || r.images.thumbFallback
                  const next = NEXT_TEXT[r.nextStep]
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="rounded-l-lg border-y border-l border-slate-200 bg-white py-3 pl-2">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5"
                          checked={selected.includes(r.id)}
                          onChange={() => toggle(r.id)}
                        />
                      </td>
                      <td className="border-y border-slate-200 bg-white py-3">
                        <div className="flex flex-col gap-0.5">
                          <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[11px] text-white">
                            {r.code || '—'}
                          </span>
                          {r.libraryState === 'rpa' && (
                            <span className="rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">RPA 档案库</span>
                          )}
                        </div>
                      </td>
                      <td className="border-y border-slate-200 bg-white py-3 pr-3">
                        <div className="flex items-start gap-2.5">
                          {thumb ? (
                            <img
                              src={api.proxyImageUrl(thumb)}
                              alt=""
                              className="h-10 w-10 shrink-0 rounded border border-slate-200 object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50">
                              <ImageIcon className="h-4 w-4 text-slate-300" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="line-clamp-2 text-[13px] font-medium text-slate-800">
                              {r.title || '(未命名产品)'}
                            </div>
                            {r.titleEn && (
                              <div className="mt-0.5 line-clamp-1 text-[11px] text-slate-500">{r.titleEn}</div>
                            )}
                            {r.sourceUrl && (
                              <a
                                href={r.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-0.5 inline-block text-[11px] text-blue-600 hover:underline"
                              >
                                1688 链接
                              </a>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="border-y border-slate-200 bg-white py-3">
                        {r.specs.complete ? (
                          <span className="text-[11px] text-emerald-600">齐全</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {r.specs.missing.map((m) => (
                              <span
                                key={m}
                                className={cn(
                                  'rounded border px-1.5 py-0.5 text-[10px]',
                                  r.specs.criticalMissing.includes(m)
                                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                                    : 'border-slate-200 bg-slate-50 text-slate-500'
                                )}
                              >
                                缺{m}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="border-y border-slate-200 bg-white py-3">
                        {r.hasEval ? (
                          <div className="text-[12px]">
                            <span
                              className={cn(
                                'font-semibold',
                                (r.score ?? 0) >= 75 ? 'text-emerald-600' : (r.score ?? 0) >= 60 ? 'text-amber-600' : 'text-rose-600'
                              )}
                            >
                              {r.score ?? '—'}
                            </span>
                            <span className="ml-1 text-slate-500">{r.verdict ?? ''}</span>
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400">未评估</span>
                        )}
                      </td>
                      <td className="border-y border-slate-200 bg-white py-3">
                        {r.hasListing ? (
                          <span className="text-[11px] text-emerald-600">已生成</span>
                        ) : (
                          <span className="text-[11px] text-slate-400">未生成</span>
                        )}
                        {r.status === 'archived' && r.reviewNote && (
                          <div className="mt-0.5 line-clamp-2 text-[10px] text-rose-500">驳回：{r.reviewNote}</div>
                        )}
                      </td>
                      <td className="border-y border-slate-200 bg-white py-3 text-[11px] text-slate-500">
                        {r.images.ai > 0 ? `${r.images.ai} 张` : '—'}
                      </td>
                      <td className="border-y border-slate-200 bg-white py-3">
                        <span className={cn('rounded border px-1.5 py-0.5 text-[11px]', NEXT_STYLE[r.nextStep])}>
                          {next.label}
                        </span>
                      </td>
                      <td className="rounded-r-lg border-y border-r border-slate-200 bg-white py-3 pr-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => goNext(r)} disabled={evaluatingId === r.id}>
                            {evaluatingId === r.id ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <ArrowRight className="mr-1 h-3 w-3" />
                            )}
                            {next.action}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-slate-500"
                            onClick={() => navigate(`/listing/${r.id}`)}
                            title="打开完整编辑页（资料 / 评估 / 文案 / 出图）"
                          >
                            打开
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className={r.status === 'trashed' ? 'text-rose-600' : 'text-slate-400'}
                            onClick={() => void removeRow(r)}
                            title={r.status === 'trashed' ? '永久删除' : '移到回收站'}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <div className="mt-1 flex gap-1">
                          <StepDot done={r.specs.complete} label="资料" />
                          <StepDot done={r.hasEval} label="评估" />
                          <StepDot done={r.hasListing} label="文案" />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-4 py-3 text-[12px] leading-relaxed text-slate-600">
        <span className="font-medium text-slate-800">怎么用这一页：</span>
        每天先看上面六个数字 —— 待补资料的去补箱规、待评估的点「去评估」、待生成文案的勾上然后一次性批量生成，
        生成完会进「英文链接待审核」，审核通过原地址就变成正式产品。所有步骤改的都是同一条档案，
        不存在「评估库一份、批量一份、产品库又一份」。
      </div>
    </div>
  )
}
