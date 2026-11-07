import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Clock3, ExternalLink, Loader2, RotateCcw, Search, Sparkles, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SectionCard, VerdictBadge } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import type { FlowRow } from '@/types'
import { ReviewCenterPanel, ReviewDrawer } from './ReviewCenter'

type Tab = 'pending' | 'approved' | 'rejected'

/**
 * 英文链接待审核。
 *
 * 这里不再是「另开的第二个库」：待审核就是产品档案里状态为 pending_review 的那些，
 * 已驳回就是 archived 的那些。所以通过 = 这条档案原地变成正式产品，
 * 驳回 = 这条档案标归档（资料/评估/图片一条不丢，改完能重新生成）。
 */
export default function ListingReviews() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('pending')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<FlowRow[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 })
  /** flow=流水线里待审核的文案；drafts=批量生成的草稿（两个原来分开的页面，现在合一页两个视图） */
  const [mode, setMode] = useState<'flow' | 'drafts'>('flow')
  /** 点「打开」时用：产品 id → 对应的审核记录 id（有记录就打开完整英文链接抽屉） */
  const [reviewId, setReviewId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (tab === 'pending') {
        const r = await api.listFlowReviews(q || undefined, 'pending')
        setRows(r.reviews)
      } else if (tab === 'approved') {
        const r = await api.listFlowReviews(q || undefined, 'approved')
        setRows(r.reviews)
      } else {
        const r = await api.listFlowProducts({ need: 'rejected', limit: 200, q: q || undefined })
        setRows(r.rows)
      }
      const o = await api.getFlowOverview()
      setCounts({ pending: o.pendingReview, approved: o.inPreLibrary ?? o.listed, rejected: o.archived })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [tab, q])

  useEffect(() => {
    void load()
    // 后台生成/审核状态会变：每 10 秒自动拉一次，不用手动点刷新
    const timer = window.setInterval(() => void load(), 10_000)
    return () => window.clearInterval(timer)
  }, [load])

  const approve = async (ids: string[]) => {
    if (!ids.length) return
    setBusy(true)
    try {
      const r = await api.approveFlowReviews(ids)
      if (r.failed.length) {
        toast.warning(`通过 ${r.approved.length} 条，${r.failed.length} 条失败`)
      } else {
        toast.success(`已通过 ${r.approved.length} 条，已进正式产品库`)
      }
      setSelected([])
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 驳回「已经通过」的：产品从预产品库下架、标成已驳回，文案保留可以改完重新生成再审。
   */
  /**
   * 批量生成英文链接：把选中的（或当前列表全部）产品丢进后台队列，一条一条生成。
   * 生成完会自动变成上面的待审核卡片；进度在最上面的「AI 正在生成」面板里看。
   */
  const generateListings = async (ids: string[]) => {
    const productIds = ids.filter(Boolean)
    if (!productIds.length) return
    const withDraft = productIds.filter((pid) => reviewByProduct.has(pid))
    const msg =
      `为这 ${productIds.length} 个产品生成英文链接？\n\n` +
      (withDraft.length
        ? `其中 ${withDraft.length} 个已经有文案草稿，重新生成会替换掉旧草稿（人工改过的地方会丢）。\n\n`
        : '') +
      '生成是后台排队跑的，进度在页面顶部「AI 正在生成」面板里看，完成后自动变成待审核卡片。'
    if (!window.confirm(msg)) return
    setBusy(true)
    try {
      const { job } = await api.createProductionJob({
        kind: 'listing',
        productIds: productIds.slice(0, 20),
        clientKey: `gen-${Date.now()}`,
      })
      localStorage.setItem('asi-production:jobId', job.id)
      toast.success(`已开始为 ${job.items.length} 个产品生成英文链接`)
      setSelected([])
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const unapprove = async (ids: string[]) => {
    if (!ids.length) return
    const note = window.prompt(
      `驳回这 ${ids.length} 条已经通过的产品？\n\n产品会从预产品库下架并标为已驳回；文案保留，可改完重新生成再审。\n\n驳回原因（可留空）：`,
      ''
    )
    if (note === null) return
    setBusy(true)
    try {
      const r = await api.unapproveFlowReviews(ids, note)
      toast.success(`已驳回 ${r.reverted} 条，已从预产品库下架`)
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
    const note = window.prompt('驳回原因（可留空，会记在这条档案上）', '')
    if (note === null) return
    setBusy(true)
    try {
      const r = await api.rejectFlowReviews(ids, note)
      toast.success(`已驳回 ${r.rejected} 条（资料和评估都还在，改完可重新生成）`)
      setSelected([])
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** 退回「待生成文案」：清掉这条的英文文案，档案保留，可以重新生成 */
  const reopen = async (ids: string[]) => {
    if (!ids.length) return
    if (!window.confirm(`把这 ${ids.length} 条的英文文案清掉、退回「待生成文案」？（资料和评估保留）`)) return
    setBusy(true)
    try {
      const r = await api.reopenFlowReviews(ids)
      toast.success(`已退回 ${r.reopened} 条，可到流水线重新生成`)
      setSelected([])
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const allChecked = rows.length > 0 && rows.every((r) => selected.includes(r.id))

  // 产品 → 审核记录：流水线视图点「打开」时，直接打开完整英文链接抽屉
  // （正文四段 + 分类/主题/材质/印刷/包装/箱规/阶梯报价/中文对照，不用再跳产品页找）
  const queueQuery = useQuery({
    queryKey: ['listing-review-map'],
    queryFn: () => api.listReviewQueue({ status: 'all', limit: 300 }),
    refetchInterval: 15_000,
  })
  const reviewByProduct = useMemo(() => {
    const map = new Map<string, { id: string; status: string }>()
    for (const item of queueQuery.data?.reviews ?? []) {
      if (!item.productId) continue
      const prev = map.get(item.productId)
      if (!prev || (item.status === 'pending' && prev.status !== 'pending')) {
        map.set(item.productId, { id: item.id, status: item.status })
      }
    }
    return map
  }, [queueQuery.data])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {([
          { key: 'flow', label: '流水线待审核文案' },
          { key: 'drafts', label: '批量生成草稿（含质检）' },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setMode(t.key)}
            className={
              mode === t.key
                ? 'rounded-full border border-blue-300 bg-blue-50 px-3 py-1 text-[12px] font-semibold text-blue-700'
                : 'rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-500 hover:border-slate-300'
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 已通过评估、文案还没生成的产品：立刻出现在这里，带 AI 进度，不用等生成完 */}
      <GeneratingPanel onOpenProduct={(id) => navigate(`/listing/${id}`)} />

      {mode === 'drafts' ? (
        <ReviewCenterPanel />
      ) : (
      <SectionCard
        title="英文链接待审核"
        hint="待审核 = 产品档案里「文案已生成、还没确认」的那些。点「打开」进完整编辑页，文案/图片/报价都能改；通过就进正式产品库。"
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="border-orange-200 bg-orange-50 text-orange-700">
              待审核 {counts.pending}
            </Badge>
            <Badge variant="outline" className="border-rose-200 bg-rose-50 text-rose-600">
              已驳回 {counts.rejected}
            </Badge>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {(['pending', 'approved', 'rejected'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTab(t)
                setSelected([])
              }}
              className={[
                'rounded-full border px-3 py-1 text-[12px]',
                tab === t
                  ? 'border-blue-300 bg-blue-50 font-semibold text-blue-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300',
              ].join(' ')}
            >
              {t === 'pending'
                ? `待审核（${counts.pending}）`
                : t === 'approved'
                  ? `已通过（${counts.approved}）`
                  : `已驳回（${counts.rejected}）`}
            </button>
          ))}
          <div className="relative ml-1">
            <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜编号 / 标题 / 链接"
              className="h-7 w-60 rounded border border-slate-200 pl-7 pr-2 text-[12px] outline-none focus:border-blue-400"
            />
          </div>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null} 刷新
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-400">共 {rows.length} 条</span>
            {(tab === 'pending' || tab === 'approved') && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !(selected.length || rows.length)}
                onClick={() => void generateListings(selected.length ? selected : rows.map((r) => r.id))}
              >
                <Sparkles className="mr-1 h-3.5 w-3.5" /> 批量生成英文链接（{selected.length || rows.length}）
              </Button>
            )}
            {selected.length > 0 && tab === 'pending' && (
              <>
                <Button size="sm" disabled={busy} onClick={() => void approve(selected)}>
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 通过选中（{selected.length}）
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void reject(selected)}>
                  <XCircle className="mr-1 h-3.5 w-3.5" /> 驳回
                </Button>
              </>
            )}
            {selected.length > 0 && tab === 'approved' && (
              <Button size="sm" variant="outline" className="text-rose-600" disabled={busy} onClick={() => void unapprove(selected)}>
                <XCircle className="mr-1 h-3.5 w-3.5" /> 驳回已通过（{selected.length}）
              </Button>
            )}
            {selected.length > 0 && tab === 'rejected' && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void reopen(selected)}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" /> 退回待生成（{selected.length}）
              </Button>
            )}
          </div>
        </div>

        {tab === 'pending' && rows.length > 1 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-2 text-[12px] text-blue-800">
            <span>建议一条条点「打开」核对再通过；确认批量没问题时，可以全选一次通过。</span>
            <Button size="sm" variant="outline" onClick={() => setSelected(rows.map((r) => r.id))}>
              全选待审核（{rows.length}）
            </Button>
          </div>
        )}

        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-[12px]">
            <thead className="text-[11px] text-slate-400">
              <tr className="border-b border-slate-100">
                <th className="w-8 py-2 pr-2">
                  <Checkbox checked={allChecked} onCheckedChange={(v) => setSelected(v ? rows.map((r) => r.id) : [])} />
                </th>
                <th className="py-2 pr-2 font-medium">编号</th>
                <th className="py-2 pr-2 font-medium">图</th>
                <th className="py-2 pr-2 font-medium">产品 / 英文标题</th>
                <th className="py-2 pr-2 font-medium">分数</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const thumb = r.images.thumb || r.images.thumbFallback
                return (
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
                      <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-white">
                        {r.code || '—'}
                      </span>
                    </td>
                    <td className="py-2 pr-2">
                      {thumb ? (
                        <img src={thumb} alt="" className="h-10 w-10 rounded border border-slate-200 object-cover" />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="max-w-[460px] py-2 pr-2">
                      <div className="truncate font-medium text-slate-800" title={r.titleEn || r.title}>
                        {r.titleEn || r.title || '(未命名)'}
                      </div>
                      <div className="truncate text-[11px] text-slate-500">{r.title}</div>
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
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => navigate(`/listing/${r.id}`)}
                        >
                          打开完整编辑页
                        </Button>
                        {tab === 'pending' ? (
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
                        ) : tab === 'approved' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px] text-rose-600"
                            onClick={() => void unapprove([r.id])}
                          >
                            驳回（下架）
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px] text-slate-600"
                            onClick={() => void reopen([r.id])}
                          >
                            退回待生成
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!rows.length && !loading && (
            <div className="py-10 text-center text-[12px] text-slate-400">
              {tab === 'pending'
                ? '现在没有待审核的产品。在「产品流水线」里生成英文文案后，会出现在这里。'
                : '还没有被驳回的产品。'}
            </div>
          )}
        </div>
      </SectionCard>
      )}
      {reviewId && (
        <ReviewDrawer
          id={reviewId}
          onClose={() => setReviewId(null)}
          onChanged={() => void load()}
          onApproved={() => {
            setSelected([])
            void load()
          }}
        />
      )}
    </div>
  )
}

/**
 * 「AI 正在生成」面板。
 *
 * 评估通过的那一刻起，产品就该出现在待审核中心 —— 哪怕文案还没生成完。
 * 这里显示后台任务的状态（排队 / 生成中 / 失败原因），每 3 秒自动刷新；
 * 生成完成后会自动变成正常的待审核卡片（列表另有 10 秒轮询）。
 */
function GeneratingPanel({ onOpenProduct }: { onOpenProduct: (productId: string) => void }) {
  const { data, isFetching } = useQuery({
    queryKey: ['pending-generation'],
    queryFn: api.getPendingGeneration,
    refetchInterval: (query) => {
      const rows = query.state.data?.rows ?? []
      // 有在排队/在跑的才高频刷新，全部失败或为空时降频，避免空转
      return rows.some((r) => r.status === 'running' || r.status === 'queued' || r.status === 'unknown') ? 3000 : 15000
    },
  })

  const rows = data?.rows ?? []
  if (!rows.length) return null

  const running = rows.filter((r) => r.status === 'running').length
  const queued = rows.filter((r) => r.status === 'queued' || r.status === 'unknown').length
  const failed = rows.filter((r) => r.status === 'failed').length

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/50 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-blue-800">
          {(running > 0 || queued > 0) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          AI 正在生成文案（{rows.length}）
        </span>
        {queued > 0 && <span className="text-[11px] text-slate-500">排队 {queued}</span>}
        {running > 0 && <span className="text-[11px] text-blue-600">生成中 {running}</span>}
        {failed > 0 && <span className="text-[11px] text-rose-600">失败 {failed}</span>}
        <span className="ml-auto text-[11px] text-slate-400">
          {isFetching ? '刷新中…' : '自动刷新中，生成完会自动出现在下面'}
        </span>
      </div>
      <div className="mt-2 space-y-1">
        {rows.map((r) => (
          <div key={r.productId} className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5">
            {r.status === 'running' ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-600" />
            ) : r.status === 'failed' ? (
              <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
            ) : (
              <Clock3 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            )}
            <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-white">{r.code || '—'}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-slate-700">{r.title || '(未命名)'}</span>
            <span className={r.status === 'failed' ? 'text-[11px] text-rose-600' : 'text-[11px] text-slate-500'}>
              {r.status === 'failed' ? r.error || '生成失败' : r.stage || '生成中'}
            </span>
            {r.status === 'failed' && r.jobId && r.itemIdx != null && (
              <button
                className="shrink-0 rounded border border-rose-200 px-1.5 py-0.5 text-[10px] text-rose-600 hover:border-rose-300"
                onClick={async () => {
                  try {
                    await api.retryProductionItem(r.jobId as string, r.itemIdx as number)
                    toast.success('已重新排队')
                  } catch (err) {
                    toast.error(getErrorMessage(err))
                  }
                }}
              >
                重试
              </button>
            )}
            <button
              className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:border-blue-300"
              onClick={() => onOpenProduct(r.productId)}
            >
              打开
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
