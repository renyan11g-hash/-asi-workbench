import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, ChevronDown, ExternalLink, Loader2, Search, Trash2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SectionCard, VerdictBadge } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import { ListingReview, ListingReviewSummary, ReviewStatus } from '@/types'

const STATUS_LABEL: Record<ReviewStatus, { label: string; cls: string }> = {
  pending: { label: '待审核', cls: 'bg-orange-100 text-orange-700 border-orange-200' },
  approved: { label: '已通过', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  rejected: { label: '已驳回', cls: 'bg-rose-100 text-rose-600 border-rose-200' },
}

/**
 * 英文链接待审核库。
 *
 * 批量生成的 listing 先落在这里，不动产品库 —— 标题/卖点写歪了直接上传 ASI ESP 再改很贵，
 * 所以必须先人工过一遍：通过 → 用单品同一条入库逻辑写进产品库；驳回 → 留档 + 原因。
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
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<ListingReview | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editSummary, setEditSummary] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

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

  const openDetail = async (id: string) => {
    if (expanded === id) {
      setExpanded(null)
      setDetail(null)
      return
    }
    setExpanded(id)
    setDetail(null)
    setDetailLoading(true)
    try {
      const r = await api.getListingReview(id)
      setDetail(r)
      setEditTitle(r.listing?.title ?? '')
      setEditSummary(r.listing?.summary ?? '')
      setEditDesc(r.listing?.description ?? '')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDetailLoading(false)
    }
  }

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
      setExpanded(null)
      setDetail(null)
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
    if (!window.confirm(`确定删除这 ${ids.length} 条待审核记录？（删除后不可恢复，已通过的不受影响）`)) return
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

  const saveEdit = async () => {
    if (!detail) return
    setSavingEdit(true)
    try {
      const r = await api.updateListingReview(detail.id, {
        title: editTitle,
        summary: editSummary,
        description: editDesc,
      })
      setDetail(r)
      toast.success('已保存修改（还没入库，点「通过」才进产品库）')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSavingEdit(false)
    }
  }

  const allChecked = rows.length > 0 && rows.every((r) => selected.includes(r.id))
  const pendingRows = useMemo(() => rows.filter((r) => r.status === 'pending'), [rows])

  return (
    <div className="space-y-4">
      <SectionCard
        title="英文链接待审核"
        hint="批量生成的英文 listing 先在这里审：通过 = 进产品库；驳回 = 留档并记原因。审核通过才会出现在产品库里。"
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

        {status === 'pending' && pendingRows.length > 0 && selected.length === 0 && (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-2 text-[12px] text-blue-800">
            <span>审核通过的会立刻进产品库，所以先看清楚标题和描述。</span>
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
                <th className="py-2 pr-2 font-medium">英文标题 / 来源</th>
                <th className="py-2 pr-2 font-medium">分数</th>
                <th className="py-2 pr-2 font-medium">状态</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <>
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
                        <img
                          src={r.image}
                          alt=""
                          className="h-10 w-10 rounded border border-slate-200 object-cover"
                        />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="max-w-[420px] py-2 pr-2">
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
                        {r.score != null && <span>评分 {r.score}</span>}
                        {r.reviewNote && <span className="text-rose-600">驳回：{r.reviewNote}</span>}
                      </div>
                    </td>
                    <td className="py-2 pr-2">
                      {r.score != null ? (
                        <VerdictBadge
                          verdict={(r.verdict as 'GO' | 'MAYBE' | 'NO' | null) ?? null}
                          score={r.score}
                        />
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
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => void openDetail(r.id)}>
                          <ChevronDown
                            className={['mr-0.5 h-3 w-3 transition', expanded === r.id ? 'rotate-180' : ''].join(' ')}
                          />
                          {expanded === r.id ? '收起' : '查看'}
                        </Button>
                        {r.status === 'pending' && (
                          <>
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-emerald-700" onClick={() => void approve([r.id])}>
                              通过
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-rose-600" onClick={() => void reject([r.id])}>
                              驳回
                            </Button>
                          </>
                        )}
                        {r.productId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px]"
                            onClick={() => navigate(`/listing/${r.productId}`)}
                          >
                            打开产品
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-slate-400" onClick={() => void remove([r.id])}>
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr key={`${r.id}-detail`} className="border-b border-slate-100 bg-slate-50/60">
                      <td colSpan={6} className="px-3 py-3">
                        {detailLoading && (
                          <div className="flex items-center gap-2 text-[12px] text-slate-500">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 载入…
                          </div>
                        )}
                        {detail && detail.id === r.id && (
                          <div className="space-y-3">
                            <div className="grid gap-3 lg:grid-cols-2">
                              <div className="rounded-lg border border-slate-200 bg-white p-3">
                                <div className="text-[11px] font-medium text-slate-500">英文标题（可改，通过后就是 ESP 上的标题）</div>
                                <textarea
                                  value={editTitle}
                                  onChange={(e) => setEditTitle(e.target.value)}
                                  rows={2}
                                  className="mt-1 w-full rounded border border-slate-200 p-2 text-[12px]"
                                />
                                <div className="mt-2 text-[11px] font-medium text-slate-500">卖点 / 简述</div>
                                <textarea
                                  value={editSummary}
                                  onChange={(e) => setEditSummary(e.target.value)}
                                  rows={3}
                                  className="mt-1 w-full rounded border border-slate-200 p-2 text-[12px]"
                                />
                                <div className="mt-2 text-[11px] font-medium text-slate-500">描述</div>
                                <textarea
                                  value={editDesc}
                                  onChange={(e) => setEditDesc(e.target.value)}
                                  rows={6}
                                  className="mt-1 w-full rounded border border-slate-200 p-2 text-[12px]"
                                />
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <Button size="sm" variant="outline" disabled={savingEdit} onClick={() => void saveEdit()}>
                                    {savingEdit ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                                    保存修改
                                  </Button>
                                  {r.status === 'pending' && (
                                    <Button size="sm" onClick={() => void approve([r.id])} disabled={busy}>
                                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 通过并入库
                                    </Button>
                                  )}
                                </div>
                              </div>
                              <div className="rounded-lg border border-slate-200 bg-white p-3 text-[12px] text-slate-700">
                                <div className="text-[11px] font-medium text-slate-500">关键词</div>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {(detail.listing?.keywords ?? []).map((k) => (
                                    <span key={k} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px]">
                                      {k}
                                    </span>
                                  ))}
                                </div>
                                <div className="mt-3 text-[11px] font-medium text-slate-500">报价（阶梯）</div>
                                <div className="mt-1 overflow-x-auto">
                                  <table className="text-[11px]">
                                    <thead className="text-slate-400">
                                      <tr>
                                        <th className="pr-3 text-left font-medium">数量</th>
                                        <th className="pr-3 text-left font-medium">单价</th>
                                        <th className="pr-3 text-left font-medium">毛利</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(detail.priceGrid ?? []).map((row) => (
                                        <tr key={`${row.qty}-${row.shipping}`}>
                                          <td className="pr-3">{row.qty}</td>
                                          <td className="pr-3">${row.unitPrice.toFixed(2)}</td>
                                          <td className="pr-3">{row.margin.toFixed(0)}%</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                <div className="mt-3 text-[11px] font-medium text-slate-500">1688 资料</div>
                                <div className="mt-1 leading-relaxed text-slate-600">
                                  {detail.source?.sourceTitle || '—'}
                                  <br />
                                  采购价 ¥{detail.source?.priceCny ?? '—'} · 材质 {detail.source?.materialCn || '—'} · 尺寸{' '}
                                  {detail.source?.sizeCn || '—'}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
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
