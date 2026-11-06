import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, ExternalLink, Loader2, Search, Trash2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SectionCard, VerdictBadge } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import { ListingReviewSummary, ReviewStatus } from '@/types'

const STATUS_LABEL: Record<ReviewStatus, { label: string; cls: string }> = {
  pending: { label: '待审核', cls: 'bg-orange-100 text-orange-700 border-orange-200' },
  approved: { label: '已通过', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  rejected: { label: '已驳回', cls: 'bg-rose-100 text-rose-600 border-rose-200' },
}

/**
 * 英文链接待审核库。
 *
 * 生成链接时产品就已经建好了（状态 pending_review，产品库列表看不到），
 * 所以这里点「打开」进的就是单品那套完整的英文链接生成页 ——
 * 标题、卖点、描述、关键词、QC、阶梯报价、出图全都在，和单个生成时一模一样。
 * 通过 = 产品状态改成正式；驳回 = 标归档（数据不删）。
 */
export default function ListingReviews() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<ReviewStatus>('pending')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<ListingReviewSummary[]>([])
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 })
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.listListingReviews({ status, q, limit: 200 })
      setRows(r.reviews)
      setCounts(r.counts)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [status, q])

  useEffect(() => {
    void load()
  }, [load])

  const approve = async (ids: string[]) => {
    if (!ids.length) return
    setBusy(true)
    try {
      const r = await api.approveListingReviews(ids)
      if (r.failed.length) {
        toast.warning(`通过 ${r.approved.length} 条，${r.failed.length} 条失败：${r.failed[0].error}`)
      } else {
        toast.success(`已通过 ${r.approved.length} 条，已进产品库`)
      }
      setSelected([])
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const reject = async (ids: string[]) => {
    if (!ids.length) return
    const note = window.prompt('驳回原因（可留空，会记在这条上）', '')
    if (note === null) return
    setBusy(true)
    try {
      const r = await api.rejectListingReviews(ids, note)
      toast.success(`已驳回 ${r.rejected} 条`)
      setSelected([])
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (ids: string[]) => {
    if (!ids.length) return
    if (!window.confirm(`确定删除这 ${ids.length} 条待审核记录？产品也会一并删掉（已通过的不受影响）`)) return
    setBusy(true)
    try {
      const r = await api.deleteListingReviews(ids)
      toast.success(`已删除 ${r.removed} 条`)
      setSelected([])
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const allChecked = rows.length > 0 && rows.every((r) => selected.includes(r.id))
  const pendingRows = rows.filter((r) => r.status === 'pending')

  return (
    <div className="space-y-4">
      <SectionCard
        title="英文链接待审核"
        hint="点「打开」进的就是完整的英文链接生成页（和单个生成时一样，标题/卖点/描述/关键词/QC/报价都能改）。审完点通过 → 进产品库；驳回 → 归档留原因。"
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
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {(['pending', 'approved', 'rejected'] as ReviewStatus[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setStatus(s)
                setSelected([])
              }}
              className={[
                'rounded-full border px-3 py-1 text-[12px]',
                status === s
                  ? 'border-blue-300 bg-blue-50 font-semibold text-blue-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300',
              ].join(' ')}
            >
              {STATUS_LABEL[s].label}
            </button>
          ))}
          <div className="relative ml-1">
            <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜标题 / 链接"
              className="h-7 w-56 rounded border border-slate-200 pl-7 pr-2 text-[12px] outline-none focus:border-blue-400"
            />
          </div>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null} 刷新
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-400">共 {rows.length} 条</span>
            {selected.length > 0 && (
              <>
                <Button size="sm" disabled={busy} onClick={() => void approve(selected)}>
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 通过选中（{selected.length}）
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void reject(selected)}>
                  <XCircle className="mr-1 h-3.5 w-3.5" /> 驳回
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-rose-600"
                  disabled={busy}
                  onClick={() => void remove(selected)}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> 删除
                </Button>
              </>
            )}
          </div>
        </div>

        {status === 'pending' && pendingRows.length > 1 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-2 text-[12px] text-blue-800">
            <span>一条条点「打开」审核最稳；嫌麻烦可以全选后一次通过。</span>
            <Button size="sm" variant="outline" onClick={() => setSelected(pendingRows.map((r) => r.id))}>
              全选待审核（{pendingRows.length}）
            </Button>
          </div>
        )}

        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-[12px]">
            <thead className="text-[11px] text-slate-400">
              <tr className="border-b border-slate-100">
                <th className="w-8 py-2 pr-2">
                  <Checkbox
                    checked={allChecked}
                    onCheckedChange={(v) => setSelected(v ? rows.map((r) => r.id) : [])}
                  />
                </th>
                <th className="py-2 pr-2 font-medium">图</th>
                <th className="py-2 pr-2 font-medium">产品 / 英文标题</th>
                <th className="py-2 pr-2 font-medium">分数</th>
                <th className="py-2 pr-2 font-medium">状态</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 align-top">
                  <td className="py-2 pr-2">
                    <Checkbox
                      checked={selected.includes(r.id)}
                      onCheckedChange={(v) =>
                        setSelected((cur) => (v ? [...cur, r.id] : cur.filter((x) => x !== r.id)))
                      }
                    />
                  </td>
                  <td className="py-2 pr-2">
                    {r.image ? (
                      <img src={r.image} alt="" className="h-10 w-10 rounded border border-slate-200 object-cover" />
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="max-w-[460px] py-2 pr-2">
                    <div className="truncate font-medium text-slate-800" title={r.title}>
                      {r.title}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                      {r.sourceUrl && (
                        <a
                          href={r.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-blue-600 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" /> 1688 来源
                        </a>
                      )}
                      {r.batchJobId && <span>批次 {r.batchIdx} 号</span>}
                      {r.reviewNote && <span className="text-rose-600">驳回：{r.reviewNote}</span>}
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    {r.score != null ? (
                      <VerdictBadge verdict={(r.verdict as 'GO' | 'MAYBE' | 'NO' | null) ?? null} score={r.score} />
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    <Badge variant="outline" className={STATUS_LABEL[r.status]?.cls}>
                      {STATUS_LABEL[r.status]?.label ?? r.status}
                    </Badge>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        disabled={!r.productId}
                        onClick={() => r.productId && navigate(`/listing/${r.productId}`)}
                      >
                        打开完整编辑页
                      </Button>
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
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px] text-slate-400"
                        onClick={() => void remove([r.id])}
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && !loading && (
            <div className="py-10 text-center text-[12px] text-slate-400">
              没有 {STATUS_LABEL[status].label} 的记录。批量处理里点「⑤ 生成英文链接」后，链接会出现在这里。
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  )
}
