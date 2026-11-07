import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Wand2,
  X,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Listing, ListingQcReport, ListingReview } from '@/types'

type Tab = 'pending' | 'approved' | 'rejected' | 'all'

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: '待审核', cls: 'border-orange-200 bg-orange-50 text-orange-700' },
  approved: { label: '已通过', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  rejected: { label: '已驳回', cls: 'border-rose-200 bg-rose-50 text-rose-600' },
}

function qcBadge(qc: ListingQcReport | null | undefined) {
  if (!qc) return <span className="text-[11px] text-slate-400">未检查</span>
  const failed = qc.checks.filter((c) => !c.ok)
  const errors = failed.filter((c) => c.level === 'error')
  if (errors.length) {
    return (
      <Badge variant="outline" className="border-rose-200 bg-rose-50 text-[10px] text-rose-600">
        {errors.length} 项不合格
      </Badge>
    )
  }
  if (failed.length) {
    return (
      <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-700">
        {failed.length} 项提示
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700">
      {qc.aiChecked ? '合格（含 AI 复检）' : '合格'}
    </Badge>
  )
}

/**
 * Listing 审核中心（第三阶段）。
 *
 * 批量生成的草稿都堆在这里：一行一个产品，能看质检、能直接改、能单字段重生成、
 * 能单条/批量通过。通过前**不会**动产品库里现有的 Listing —— 这是这一页存在的意义。
 */
export function ReviewCenterPanel() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('pending')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const listQuery = useQuery({
    queryKey: ['review-queue', tab, q],
    queryFn: () => api.listReviewQueue({ status: tab, q: q || undefined, limit: 200 }),
  })

  const rows = listQuery.data?.reviews ?? []
  const counts = listQuery.data?.counts ?? { pending: 0, approved: 0, rejected: 0 }

  const needsWork = useMemo(
    () => rows.filter((r) => r.status === 'pending' && (r.qc ? !r.qc.ok : true)),
    [rows]
  )
  const qualified = useMemo(
    () => rows.filter((r) => r.status === 'pending' && r.qc?.ok),
    [rows]
  )

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['review-queue'] })
    qc.invalidateQueries({ queryKey: ['flow-overview'] })
  }

  const approve = async (ids: string[]) => {
    if (!ids.length) return
    setBusy(true)
    try {
      const r = await api.approveReviews(ids)
      if (r.failed.length) toast.warning(`通过 ${r.approved.length} 条，${r.failed.length} 条失败：${r.failed[0].error}`)
      else toast.success(`已通过 ${r.approved.length} 条，已写回产品库`)
      setSelected([])
      refresh()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** 驳回「已经通过」的草稿：产品从预产品库下架并标驳回，文案保留 */
  const unapprove = async (ids: string[]) => {
    if (!ids.length) return
    const note = window.prompt(
      `驳回这 ${ids.length} 条已经通过的？\n\n产品会从预产品库下架并标为已驳回，文案保留（可改完重新生成再审）。\n\n驳回原因（可留空）：`,
      ''
    )
    if (note === null) return
    setBusy(true)
    try {
      const r = await api.unapproveReviews(ids, note)
      if (r.skipped.length) toast.warning(`驳回 ${r.reverted} 条，${r.skipped.length} 条跳过：${r.skipped[0].error}`)
      else toast.success(`已驳回 ${r.reverted} 条，已从预产品库下架`)
      setSelected([])
      refresh()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const reject = async (ids: string[]) => {    if (!ids.length) return
    const note = window.prompt('驳回原因（会记在这条草稿上，产品库里的现有 Listing 不受影响）', '')
    if (note === null) return
    setBusy(true)
    try {
      const r = await api.rejectReviews(ids, note)
      toast.success(`已驳回 ${r.rejected} 条`)
      setSelected([])
      refresh()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const aiQc = async (ids: string[]) => {
    setBusy(true)
    try {
      const r = await api.reviewBulkAiQc(ids)
      const failed = r.results.filter((x) => x.error)
      toast.success(`复检完成 ${r.results.length - failed.length} 条${failed.length ? `，${failed.length} 条出错` : ''}`)
      refresh()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** 只重新生成不合格/失败的那些（回到批量生产中心跑） */
  const regenerateBad = async () => {
    const ids = needsWork.map((r) => r.productId).filter((x): x is string => Boolean(x))
    if (!ids.length) {
      toast.info('没有需要重生成的记录')
      return
    }
    if (!window.confirm(`对 ${ids.length} 条质检不合格/未检查的产品重新生成整条 Listing？\n\n会先删掉这些产品还没审的旧草稿，再排队生成新的。`)) return
    setBusy(true)
    try {
      const { job } = await api.createProductionJob({
        kind: 'listing',
        productIds: Array.from(new Set(ids)).slice(0, 20),
        clientKey: `regen-${Date.now()}`,
      })
      localStorage.setItem('asi-production:jobId', job.id)
      toast.success(`已提交 ${job.items.length} 条重生成，正在后台跑`)
      navigate('/production')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const allChecked = rows.length > 0 && rows.every((r) => selected.includes(r.id))

  return (
    <div className="space-y-4">
      <SectionCard
        title="Listing 审核中心"
        hint="批量生成的草稿都在这里。审核通过才写回产品库 —— 批量生成本身不会覆盖现有 Listing。"
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="border-orange-200 bg-orange-50 text-orange-700">
              待审核 {counts.pending}
            </Badge>
            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
              已通过 {counts.approved}
            </Badge>
            <Badge variant="outline" className="border-rose-200 bg-rose-50 text-rose-600">
              已驳回 {counts.rejected}
            </Badge>
            <a href={api.reviewExportUrl({ ids: selected.length ? selected : undefined, status: tab })} download>
              <Button size="sm" variant="outline">
                <Download className="mr-1 h-3.5 w-3.5" /> 导出 Excel
              </Button>
            </a>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {(['pending', 'approved', 'rejected', 'all'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t)
                setSelected([])
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-[12px]',
                tab === t
                  ? 'border-blue-300 bg-blue-50 font-semibold text-blue-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
              )}
            >
              {{ pending: '待审核', approved: '已通过', rejected: '已驳回', all: '全部' }[t]}
            </button>
          ))}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜标题 / 链接"
              className="h-7 w-56 rounded border border-slate-200 pl-7 pr-2 text-[12px] outline-none focus:border-blue-400"
            />
          </div>
          <Button size="sm" variant="ghost" onClick={refresh} disabled={listQuery.isFetching}>
            {listQuery.isFetching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            刷新
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-slate-400">共 {rows.length} 条{selected.length ? `，已选 ${selected.length}` : ''}</span>
            {tab === 'pending' && (
              <>
                <Button size="sm" variant="outline" disabled={busy || !qualified.length} onClick={() => void approve(qualified.map((r) => r.id))}>
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 批量通过合格（{qualified.length}）
                </Button>
                <Button size="sm" variant="outline" disabled={busy || !needsWork.length} onClick={() => void regenerateBad()}>
                  <RotateIcon /> 重生成不合格（{needsWork.length}）
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !rows.length}
                  onClick={() => void aiQc(selected.length ? selected : rows.slice(0, 10).map((r) => r.id))}
                >
                  <Sparkles className="mr-1 h-3.5 w-3.5" /> AI 复检
                </Button>
              </>
            )}
            {tab === 'approved' && selected.length > 0 && (
              <Button size="sm" variant="outline" className="text-rose-600" disabled={busy} onClick={() => void unapprove(selected)}>
                <XCircle className="mr-1 h-3.5 w-3.5" /> 驳回已通过（{selected.length}）
              </Button>
            )}
            {selected.length > 0 && (
              <>
                <Button size="sm" disabled={busy} onClick={() => void approve(selected)}>
                  通过选中（{selected.length}）
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void reject(selected)}>
                  <XCircle className="mr-1 h-3.5 w-3.5" /> 驳回
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-[12px]">
            <thead className="text-[11px] text-slate-400">
              <tr className="border-b border-slate-100">
                <th className="w-8 py-2">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={allChecked}
                    onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])}
                  />
                </th>
                <th className="py-2 font-medium">产品</th>
                <th className="w-[280px] py-2 font-medium">Title</th>
                <th className="w-24 py-2 font-medium">质检</th>
                <th className="w-20 py-2 font-medium">状态</th>
                <th className="w-28 py-2 font-medium">备注</th>
                <th className="w-40 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 align-top">
                  <td className="py-2">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={selected.includes(r.id)}
                      onChange={() =>
                        setSelected((cur) => (cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id]))
                      }
                    />
                  </td>
                  <td className="max-w-[300px] py-2 pr-2">
                    <div className="line-clamp-1 font-medium text-slate-800">{r.title || '(未命名)'}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                      {r.mode === 'staged' ? (
                        <span className="rounded bg-blue-50 px-1 text-[10px] text-blue-600">批量草稿</span>
                      ) : (
                        <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">单品生成</span>
                      )}
                      {r.editedAt && <span>人工改过</span>}
                      {r.sourceUrl && (
                        <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                          1688
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    <div className="line-clamp-2 text-slate-700">{r.title}</div>
                  </td>
                  <td className="py-2 pr-2">{qcBadge(r.qc)}</td>
                  <td className="py-2 pr-2">
                    <Badge variant="outline" className={cn('whitespace-nowrap', STATUS_BADGE[r.status]?.cls)}>
                      {STATUS_BADGE[r.status]?.label ?? r.status}
                    </Badge>
                  </td>
                  <td className="max-w-[160px] py-2 pr-2 text-[11px] text-rose-600">
                    <span className="line-clamp-2">{r.reviewNote || ''}</span>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setOpenId(r.id)}>
                        <Eye className="mr-1 h-3 w-3" /> 查看/改
                      </Button>
                      {r.status === 'approved' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px] text-rose-600"
                          disabled={busy}
                          title="通过之后反悔：驳回会把产品从预产品库下架，文案保留"
                          onClick={() => void unapprove([r.id])}
                        >
                          驳回（下架）
                        </Button>
                      )}
                      {r.status === 'pending' && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px] text-emerald-700"
                            onClick={() => void approve([r.id])}
                          >
                            通过
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px] text-rose-600"
                            onClick={() => void reject([r.id])}
                          >
                            驳回
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && !listQuery.isLoading && (
            <div className="py-12 text-center text-[12px] text-slate-400">
              这里还没有记录。到「批量生产中心」勾几个产品生成英文 Listing，就会出现在这里。
            </div>
          )}
        </div>
      </SectionCard>

      {openId && (
        <ReviewDrawer
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
          onApproved={() => {
            setSelected([])
            refresh()
          }}
        />
      )}
    </div>
  )
}

function RotateIcon() {
  return <RefreshCw className="mr-1 h-3.5 w-3.5" />
}

/** 右侧抽屉：完整 Listing + 质检明细 + 编辑/重生成/通过/驳回 */
function ReviewDrawer({
  id,
  onClose,
  onChanged,
  onApproved,
}: {
  id: string
  onClose: () => void
  onChanged: () => void
  onApproved: () => void
}) {
  const detailQuery = useQuery({ queryKey: ['review-detail', id], queryFn: () => api.getReviewDetail(id) })
  const navigate = useNavigate()
  const [draft, setDraft] = useState<ListingDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [instruction, setInstruction] = useState('')

  const review = detailQuery.data?.review as ListingReview | undefined

  useEffect(() => {
    if (!review) return
    setDraft(toListingDraft(review.listing ?? {}))
  }, [review])

  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      await api.patchReviewListing(id, fromListingDraft(draft))
      toast.success('已保存修改（还没通过，产品库未变）')
      onChanged()
      void detailQuery.refetch()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async (fields: Array<'title' | 'summary' | 'description' | 'keywords'>) => {
    if (review?.editedAt && !window.confirm('这条人工改过，重新生成会覆盖人工修改，确定？')) return
    setBusy(true)
    try {
      const r = await api.regenerateReviewFields(id, fields, instruction || undefined)
      toast.success('已重新生成，并重跑了质检')
      setDraft(toListingDraft(r.review.listing ?? {}))
      onChanged()
      void detailQuery.refetch()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 整条重跑：交给批量生产队列重新跑一次完整的 generateListing（分类/主题/材质/印刷/包装/报价全都会重算），
   * 而不是只重写四段文案。新产品会替换掉这条还没审的草稿，产品库里的现有 Listing 不受影响。
   */
  const fullRegenerate = async () => {
    if (!review?.productId) return
    if (
      !window.confirm(
        '按当前资料整条重跑一次？\n\n会重新生成全部字段（标题/摘要/描述/关键词/类目/主题/材质/印刷/包装/报价）。\n这条还没审的草稿会被新的替换，产品库里现有的 Listing 不受影响。'
      )
    )
      return
    setBusy(true)
    try {
      const { job } = await api.createProductionJob({
        kind: 'listing',
        productIds: [review.productId],
        clientKey: `regen-one-${review.productId}-${Date.now()}`,
      })
      localStorage.setItem('asi-production:jobId', job.id)
      toast.success('已开始整条重跑，进度在「批量生产中心」')
      onChanged()
      onClose()
      navigate('/production')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const aiCheck = async () => {    setBusy(true)
    try {
      const r = await api.reviewAiQc(id)
      toast.success(r.findings.length ? `复检发现 ${r.findings.length} 个问题` : '复检通过，没发现问题')
      void detailQuery.refetch()
      onChanged()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const approve = async () => {
    setBusy(true)
    try {
      await api.approveReviews([id])
      toast.success('已通过，Listing 已写回产品库')
      onApproved()
      onClose()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const reject = async () => {
    const note = window.prompt('驳回原因', '')
    if (note === null) return
    setBusy(true)
    try {
      await api.rejectReviews([id], note)
      toast.success('已驳回（产品库里的现有 Listing 未改动）')
      onChanged()
      onClose()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const qc = review?.qc
  const listing: Partial<Listing> = review?.listing ?? {}

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-3xl flex-col overflow-hidden bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-100 px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn(STATUS_BADGE[review?.status ?? 'pending']?.cls)}>
                {STATUS_BADGE[review?.status ?? 'pending']?.label}
              </Badge>
              <span className="truncate text-sm font-semibold text-slate-900">{review?.title || '加载中…'}</span>
            </div>
            {review?.prevListing && (
              <p className="mt-1 inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">
                <AlertTriangle className="h-3 w-3" /> 这个产品已有 Listing：通过后会替换成上面这版
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {detailQuery.isLoading || !draft ? (
            <div className="flex items-center justify-center py-20 text-sm text-slate-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载…
            </div>
          ) : (
            <div className="space-y-4">
              {/* 质检 */}
              <div className="rounded-lg border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                  <span className="text-[12px] font-semibold text-slate-700">质量检查</span>
                  <div className="flex items-center gap-1.5">
                    {qcBadge(qc)}
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => void aiCheck()}>
                      <Sparkles className="mr-1 h-3 w-3" /> AI 复检
                    </Button>
                  </div>
                </div>
                <div className="divide-y divide-slate-50">
                  {(qc?.checks ?? []).map((c) => (
                    <div key={c.key} className="flex items-start gap-2 px-3 py-1.5 text-[11px]">
                      {c.ok ? (
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      ) : c.level === 'error' ? (
                        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
                      ) : (
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                      )}
                      <div className="min-w-0">
                        <span className={cn('font-medium', c.ok ? 'text-slate-700' : c.level === 'error' ? 'text-rose-700' : 'text-amber-700')}>
                          {c.label}
                        </span>
                        <span className="ml-1 text-slate-500">{c.detail}</span>
                      </div>
                    </div>
                  ))}
                  {!qc && <div className="px-3 py-2 text-[11px] text-slate-400">这条没有质检记录（老数据）</div>}
                </div>
              </div>

              {/* 可编辑的三个正文区 */}
              {(['title', 'summary', 'description'] as const).map((field) => {
                const max = field === 'title' ? 60 : field === 'summary' ? 130 : 800
                const value = draft[field]
                const over = value.length > max
                return (
                  <div key={field}>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[12px] font-medium text-slate-700">
                        {field === 'title' ? 'Title' : field === 'summary' ? 'Summary' : 'Description'}
                      </span>
                      <span className={cn('text-[11px]', over ? 'font-semibold text-rose-600' : 'text-slate-400')}>
                        {value.length}/{max}
                      </span>
                    </div>
                    <textarea
                      value={value}
                      onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                      rows={field === 'title' ? 2 : field === 'summary' ? 3 : 8}
                      className={cn(
                        'w-full resize-y rounded-md border px-2 py-1.5 text-[12px] outline-none focus:border-blue-400',
                        over ? 'border-rose-300' : 'border-slate-200'
                      )}
                    />
                    <div className="mt-1 flex gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        disabled={busy}
                        onClick={() => void regenerate([field])}
                      >
                        <Wand2 className="mr-1 h-3 w-3" /> 只重生成这一段
                      </Button>
                    </div>
                  </div>
                )
              })}

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[12px] font-medium text-slate-700">Keywords（英文逗号分隔，应为 30 组）</span>
                  <span className="text-[11px] text-slate-400">
                    {draft.keywords.split(/[,，\n]/).filter((s) => s.trim()).length} 组
                  </span>
                </div>
                <textarea
                  value={draft.keywords}
                  onChange={(e) => setDraft({ ...draft, keywords: e.target.value })}
                  rows={5}
                  className="w-full resize-y rounded-md border border-slate-200 px-2 py-1.5 text-[12px] outline-none focus:border-blue-400"
                />
                <div className="mt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy}
                    onClick={() => void regenerate(['keywords'])}
                  >
                    <Wand2 className="mr-1 h-3 w-3" /> 只重生成关键词
                  </Button>
                </div>
              </div>

              <div>
                <div className="mb-1 text-[12px] font-medium text-slate-700">重生成要求（可选）</div>
                <input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="例如：标题突出 20oz 容量，不要写 Custom"
                  className="h-8 w-full rounded-md border border-slate-200 px-2 text-[12px] outline-none focus:border-blue-400"
                />
              </div>

              {/* 分类与主题 */}
              <details open className="rounded-lg border border-slate-200">
                <summary className="cursor-pointer px-3 py-1.5 text-[12px] font-semibold text-slate-700">
                  分类 / 主题 / 材质 / 颜色 / 印刷
                </summary>
                <div className="grid gap-2 px-3 pb-3 sm:grid-cols-2">
                  <SpecInput label="类目（主）" value={draft.category} onChange={(v) => setDraft({ ...draft, category: v })} />
                  <SpecInput
                    label="Type of Product"
                    value={draft.typeOfProduct}
                    onChange={(v) => setDraft({ ...draft, typeOfProduct: v })}
                  />
                  <SpecInput
                    label="类目（最多 2 个，逗号分隔）"
                    value={draft.categories}
                    onChange={(v) => setDraft({ ...draft, categories: v })}
                  />
                  <SpecInput
                    label="主题（5 个，逗号分隔）"
                    value={draft.themes}
                    onChange={(v) => setDraft({ ...draft, themes: v })}
                  />
                  <SpecInput label="材质" value={draft.material} onChange={(v) => setDraft({ ...draft, material: v })} />
                  <SpecInput label="颜色（用 / 分隔）" value={draft.colors} onChange={(v) => setDraft({ ...draft, colors: v })} />
                  <SpecInput
                    label="印刷方式（逗号分隔）"
                    value={draft.imprintMethods}
                    onChange={(v) => setDraft({ ...draft, imprintMethods: v })}
                  />
                  <SpecInput label="印刷面积" value={draft.imprintArea} onChange={(v) => setDraft({ ...draft, imprintArea: v })} />
                  <SpecInput label="生产周期" value={draft.productionTime} onChange={(v) => setDraft({ ...draft, productionTime: v })} />
                  <SpecInput label="包装" value={draft.packaging} onChange={(v) => setDraft({ ...draft, packaging: v })} />
                </div>
              </details>

              {/* 规格与箱规 */}
              <details className="rounded-lg border border-slate-200">
                <summary className="cursor-pointer px-3 py-1.5 text-[12px] font-semibold text-slate-700">
                  规格 / 单件重量 / 箱规
                </summary>
                <div className="grid gap-2 px-3 pb-3 sm:grid-cols-2">
                  <SpecInput
                    label="产品尺寸（英寸）"
                    value={draft.productSizeInch}
                    onChange={(v) => setDraft({ ...draft, productSizeInch: v })}
                  />
                  <SpecInput
                    label="单件重量（磅）"
                    value={draft.unitWeightLb}
                    onChange={(v) => setDraft({ ...draft, unitWeightLb: v })}
                  />
                  <SpecInput label="箱规（英寸）" value={draft.cartonSizeInch} onChange={(v) => setDraft({ ...draft, cartonSizeInch: v })} />
                  <SpecInput
                    label="整箱毛重（磅）"
                    value={draft.cartonGwLb}
                    onChange={(v) => setDraft({ ...draft, cartonGwLb: v })}
                  />
                </div>
              </details>

              {/* 注意事项 */}
              <details className="rounded-lg border border-slate-200">
                <summary className="cursor-pointer px-3 py-1.5 text-[12px] font-semibold text-slate-700">
                  注意事项 / 合规提示（一行一条）
                </summary>
                <div className="px-3 pb-3">
                  <textarea
                    value={draft.warnings}
                    onChange={(e) => setDraft({ ...draft, warnings: e.target.value })}
                    rows={3}
                    className="w-full resize-y rounded-md border border-slate-200 px-2 py-1.5 text-[12px] outline-none focus:border-blue-400"
                  />
                </div>
              </details>

              {/* 阶梯报价（只读，价格由报价引擎算） */}
              {(listing.priceGrid ?? []).length > 0 && (
                <details className="rounded-lg border border-slate-200">
                  <summary className="cursor-pointer px-3 py-1.5 text-[12px] font-semibold text-slate-700">
                    阶梯报价（{listing.priceGrid?.length} 档，只读）
                  </summary>
                  <div className="px-3 pb-3">
                    <table className="w-full text-left text-[11px]">
                      <thead className="text-slate-400">
                        <tr>
                          <th className="py-1 font-medium">数量</th>
                          <th className="py-1 font-medium">单价</th>
                          <th className="py-1 font-medium">计费重</th>
                          <th className="py-1 font-medium">运输</th>
                          <th className="py-1 font-medium">毛利率</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(listing.priceGrid ?? []).map((row, i) => (
                          <tr key={i} className="border-t border-slate-50">
                            <td className="py-1">{row.qty}</td>
                            <td className="py-1">${row.unitPrice?.toFixed(2)}</td>
                            <td className="py-1">{row.billableKg} kg</td>
                            <td className="py-1">{row.shipping === 'air' ? '空运' : '海运'}</td>
                            <td className="py-1">{Math.round((row.margin ?? 0) * 100)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {/* 中文对照 */}
              <details className="rounded-lg border border-slate-200">
                <summary className="cursor-pointer px-3 py-1.5 text-[12px] font-semibold text-slate-700">中文对照</summary>
                <div className="space-y-2 px-3 pb-3">
                  <SpecInput label="标题（中）" value={draft.titleZh} onChange={(v) => setDraft({ ...draft, titleZh: v })} />
                  <SpecInput label="摘要（中）" value={draft.summaryZh} onChange={(v) => setDraft({ ...draft, summaryZh: v })} />
                  <div>
                    <div className="mb-1 text-[11px] text-slate-500">描述（中）</div>
                    <textarea
                      value={draft.descriptionZh}
                      onChange={(e) => setDraft({ ...draft, descriptionZh: e.target.value })}
                      rows={3}
                      className="w-full resize-y rounded-md border border-slate-200 px-2 py-1.5 text-[11px] outline-none focus:border-blue-400"
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-[11px] text-slate-500">关键词（中）</div>
                    <textarea
                      value={draft.keywordsZh}
                      onChange={(e) => setDraft({ ...draft, keywordsZh: e.target.value })}
                      rows={2}
                      className="w-full resize-y rounded-md border border-slate-200 px-2 py-1.5 text-[11px] outline-none focus:border-blue-400"
                    />
                  </div>
                </div>
              </details>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3">
          <Button size="sm" onClick={() => void approve()} disabled={busy || review?.status === 'approved'}>
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 通过（写回产品库）
          </Button>
          <Button size="sm" variant="outline" onClick={() => void save()} disabled={busy || review?.status === 'approved'}>
            保存修改
          </Button>
          <Button size="sm" variant="outline" onClick={() => void regenerate(['title', 'summary', 'description', 'keywords'])} disabled={busy}>
            <Sparkles className="mr-1 h-3.5 w-3.5" /> 重生成这四段文案
          </Button>
          <Button size="sm" variant="outline" onClick={() => void fullRegenerate()} disabled={busy || !review?.productId}>
            <RotateIcon /> 整条重跑（全字段）
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-rose-600"
            onClick={() => void reject()}
            disabled={busy || review?.status === 'approved'}
          >
            驳回
          </Button>
          {review?.productId && (
            <Button size="sm" variant="ghost" className="ml-auto text-slate-500" onClick={() => navigate(`/listing/${review.productId}`)}>
              打开完整编辑页
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------- 审核抽屉用的完整 Listing 草稿 ----------------

/**
 * 审核时要能看到并改「整套英文链接信息」，不只是正文四段。
 * 这里把 Listing 拍平成一组字符串输入，保存时再转回去（列表字段用逗号/换行分隔）。
 */
interface ListingDraft {
  title: string
  summary: string
  description: string
  keywords: string
  category: string
  typeOfProduct: string
  categories: string
  themes: string
  material: string
  colors: string
  imprintMethods: string
  imprintArea: string
  productionTime: string
  packaging: string
  warnings: string
  productSizeInch: string
  unitWeightLb: string
  cartonSizeInch: string
  cartonGwLb: string
  titleZh: string
  summaryZh: string
  descriptionZh: string
  keywordsZh: string
}

function toListingDraft(l: Partial<Listing>): ListingDraft {
  const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))
  return {
    title: l.title ?? '',
    summary: l.summary ?? '',
    description: l.description ?? '',
    keywords: (l.keywords ?? []).join(', '),
    category: l.category ?? '',
    typeOfProduct: l.typeOfProduct ?? '',
    categories: (l.categories ?? []).join(', '),
    themes: (l.themes ?? []).join(', '),
    material: l.material ?? '',
    colors: l.colors ?? '',
    imprintMethods: (l.imprintMethods ?? []).join(', '),
    imprintArea: l.imprintArea ?? '',
    productionTime: l.productionTime ?? '',
    packaging: l.packaging ?? '',
    warnings: (l.warnings ?? []).join('\n'),
    productSizeInch: l.productSizeInch ?? '',
    unitWeightLb: num(l.unitWeightLb),
    cartonSizeInch: l.cartonSizeInch ?? '',
    cartonGwLb: num(l.cartonGwLb),
    titleZh: l.titleZh ?? '',
    summaryZh: l.summaryZh ?? '',
    descriptionZh: l.descriptionZh ?? '',
    keywordsZh: l.keywordsZh ?? '',
  }
}

function fromListingDraft(d: ListingDraft): Partial<Listing> {
  const list = (s: string) =>
    s
      .split(/[,，\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
  const toNum = (s: string): number | null => {
    const n = Number(s.replace(/[^\d.]/g, ''))
    return Number.isFinite(n) && s.trim() ? n : null
  }
  return {
    title: d.title,
    summary: d.summary,
    description: d.description,
    keywords: list(d.keywords),
    category: d.category,
    typeOfProduct: d.typeOfProduct,
    categories: list(d.categories),
    themes: list(d.themes),
    material: d.material,
    colors: d.colors,
    imprintMethods: list(d.imprintMethods),
    imprintArea: d.imprintArea,
    productionTime: d.productionTime,
    packaging: d.packaging,
    warnings: d.warnings
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean),
    productSizeInch: d.productSizeInch,
    unitWeightLb: toNum(d.unitWeightLb),
    cartonSizeInch: d.cartonSizeInch,
    cartonGwLb: toNum(d.cartonGwLb),
    titleZh: d.titleZh,
    summaryZh: d.summaryZh,
    descriptionZh: d.descriptionZh,
    keywordsZh: d.keywordsZh,
  }
}

function SpecInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-slate-500">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-full rounded border border-slate-200 px-2 text-[12px] outline-none focus:border-blue-400"
      />
    </label>
  )
}
