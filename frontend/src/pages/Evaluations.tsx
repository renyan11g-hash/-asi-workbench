import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SectionCard, ScoreRing, VerdictBadge } from '@/components/ui/primitives'
import { MarketEvidenceBlock } from '@/components/MarketEvidence'
import { api, getErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Evaluation, EvaluationRow, Product } from '@/types'

type Tab = 'pending' | 'approved' | 'rejected' | 'all' | 'orphan'

/** 排序：编号（GLS/RPA 编号里的数字）升/降，以及评分、更新时间 */
type SortKey = 'code_desc' | 'code_asc' | 'score_desc' | 'updated_desc'

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: 'code_desc', label: '编号从大到小' },
  { key: 'code_asc', label: '编号从小到大' },
  { key: 'score_desc', label: '评分从高到低' },
  { key: 'updated_desc', label: '最近更新在前' },
]

/** 编号拆成「前缀 + 数字」（GLS0073 → {prefix:'GLS', num:73}）；没有编号的历史草稿返回 null，永远排在最后 */
function parseCode(code: string | null | undefined): { prefix: string; num: number } | null {
  if (!code) return null
  const m = code.match(/^([A-Za-z]*)\s*(\d+)/)
  const digits = (code.match(/\d+/g) ?? []).join('')
  const num = Number(digits)
  if (!digits || !Number.isFinite(num)) return null
  return { prefix: (m?.[1] || code.replace(/\d+/g, '')).toUpperCase(), num }
}

const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  pending: { label: '待审核', cls: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700' },
  approved: { label: '已通过', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  rejected: { label: '待定', cls: 'border-slate-300 bg-slate-100 text-slate-600' },
}

/**
 * 评估库（2026-11-07 第二次改版）。
 *
 * 用户要的是「原来那个样子」：一张张评估卡，中间一个大圆圈写分数，点进去看完整评估。
 * 所以：卡片墙 + 分数圈 + 详情抽屉；新评估（产品档案上的）和老草稿（还没关联产品的）
 * 都在这一页，一条数据都没删。
 */
export default function Evaluations() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('pending')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('code_desc')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [openRow, setOpenRow] = useState<EvaluationRow | null>(null)
  /** 从产品流水线点「审核评估」直接打开对应那条的详情 */
  const [searchParams, setSearchParams] = useSearchParams()
  const openId = searchParams.get('open')

  const listQuery = useQuery({
    queryKey: ['evaluations', tab, q],
    queryFn: () => api.listEvaluations({ status: tab, q: q || undefined }),
    // 评估跑完/审核状态变化时自动出现，不用手动刷新
    refetchInterval: 15_000,
  })

  /** 列表排序：编号从大到小（默认）/ 从小到大 / 评分 / 更新时间；历史草稿没有编号，永远排最后 */
  const rows = useMemo(() => {
    const list = [...(listQuery.data?.rows ?? [])]
    const updated = (r: EvaluationRow) => new Date(r.updatedAt ?? 0).getTime() || 0
    list.sort((a, b) => {
      if (sort === 'score_desc') return (b.evalScore ?? -1) - (a.evalScore ?? -1) || updated(b) - updated(a)
      if (sort === 'updated_desc') return updated(b) - updated(a)
      const na = parseCode(a.code)
      const nb = parseCode(b.code)
      // 没有编号的（历史草稿）不参与编号排序，固定排最后
      if (na == null && nb == null) return updated(b) - updated(a)
      if (na == null) return 1
      if (nb == null) return -1
      // 不同前缀（GLS / RPA / PIP…）各自成组，组内再按数字升/降，避免两套编号互相穿插
      if (na.prefix !== nb.prefix) return na.prefix.localeCompare(nb.prefix)
      if (na.num !== nb.num) return sort === 'code_asc' ? na.num - nb.num : nb.num - na.num
      return updated(b) - updated(a)
    })
    return list
  }, [listQuery.data, sort])

  useEffect(() => {
    if (!openId) return
    const hit = rows.find((r) => r.productId === openId)
    if (hit) {
      setOpenRow(hit)
      setSearchParams({}, { replace: true })
    }
  }, [openId, rows, setSearchParams])
  const counts = listQuery.data?.counts

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  const selectedProductIds = rows
    .filter((r) => selected.includes(r.id) && r.productId)
    .map((r) => r.productId as string)

  const allChecked = rows.length > 0 && rows.every((r) => selected.includes(r.id))

  const decide = async (decision: 'approve' | 'reject') => {
    if (!selectedProductIds.length) {
      toast.error('选中的里没有已关联产品的评估（历史草稿要先建档案）')
      return
    }
    if (decision === 'reject' && !window.confirm(`把选中的 ${selectedProductIds.length} 个产品标成「待定」？评估记录会保留，可随时改判。`))
      return
    setBusy(true)
    try {
      const r = await api.evalReview({ ids: selectedProductIds, decision })
      toast.success(
        decision === 'approve'
          ? `已通过 ${r.changed} 条，正在自动生成英文链接（产品流水线可看进度）`
          : `已标为待定 ${r.changed} 条`
      )
      setSelected([])
      qc.invalidateQueries({ queryKey: ['evaluations'] })
      qc.invalidateQueries({ queryKey: ['flow-overview'] })
      qc.invalidateQueries({ queryKey: ['flow-products'] })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const reevaluate = async () => {
    if (!selectedProductIds.length) {
      toast.error('选中的里没有已关联产品的评估')
      return
    }
    setBusy(true)
    try {
      const { job } = await api.evaluateProducts({
        productIds: selectedProductIds.slice(0, 20),
        clientKey: `eval-${Date.now()}`,
      })
      localStorage.setItem('asi-production:jobId', job.id)
      toast.success(`已开始重新评估 ${job.items.length} 条`)
      setSelected([])
      navigate('/production')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const decideOne = async (row: EvaluationRow, decision: 'approve' | 'reject') => {
    if (!row.productId) return
    setBusy(true)
    try {
      await api.evalReview({ ids: [row.productId], decision })
      toast.success(decision === 'approve' ? '已通过评估，正在生成英文链接；生成后去 listing 待审核中心做最终审核' : '已标为待定')
      qc.invalidateQueries({ queryKey: ['evaluations'] })
      qc.invalidateQueries({ queryKey: ['flow-overview'] })
      setOpenRow(null)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const TABS: Array<{ key: Tab; label: string; count?: number }> = [
    { key: 'pending', label: '待审核', count: counts?.pending },
    { key: 'approved', label: '已通过', count: counts?.approved },
    { key: 'rejected', label: '待定', count: counts?.rejected },
    { key: 'all', label: '全部', count: counts?.all },
    { key: 'orphan', label: '历史草稿', count: counts?.orphan },
  ]

  return (
    <div className="space-y-4">
      <SectionCard
        title="评估库"
        hint="这里只是「评估通过」——通过后自动去生成英文链接，最终审核在 listing 待审核中心。没生成英文链接的不能通过审核（点错了可以「撤回审核」）"
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={() => void listQuery.refetch()}>
              {listQuery.isFetching ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              刷新
            </Button>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setTab(t.key)
                setSelected([])
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-[12px]',
                tab === t.key
                  ? 'border-blue-300 bg-blue-50 font-semibold text-blue-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
              )}
            >
              {t.label}
              {typeof t.count === 'number' ? `（${t.count}）` : ''}
            </button>
          ))}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜编号 / 产品名 / 结论 / 链接"
              className="h-7 w-60 rounded border border-slate-200 pl-7 pr-2 text-[12px] outline-none focus:border-blue-400"
            />
          </div>
          <label className="flex items-center gap-1 text-[11px] text-slate-500">
            排序
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="h-7 rounded border border-slate-200 bg-white px-1.5 text-[12px] text-slate-700 outline-none focus:border-blue-400"
              title="每个 tab 都按这个顺序排；历史草稿没有编号，固定排最后"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-slate-400">
              共 {rows.length} 条{selected.length ? `，已选 ${selected.length}` : ''}
            </span>
            <Button size="sm" disabled={busy || !selected.length} onClick={() => void decide('approve')}>
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 通过评估并生成文案
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !selected.length} onClick={() => void decide('reject')}>
              <XCircle className="mr-1 h-3.5 w-3.5" /> 标为待定
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !selected.length} onClick={() => void reevaluate()}>
              <Sparkles className="mr-1 h-3.5 w-3.5" /> 重新评估
            </Button>
          </div>
        </div>

        {listQuery.isLoading ? (
          <div className="flex items-center justify-center py-16 text-sm text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载评估…
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-14 text-center">
            <FileText className="mx-auto mb-2 h-6 w-6 text-slate-300" />
            <p className="text-sm font-medium text-slate-600">这一类还没有评估</p>
            <p className="mt-1 text-xs text-slate-400">
              到「产品流水线」勾选产品点批量评估，或从「产品资料库」推进到产品评估
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* 表头：全选 + 列名 */}
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500 sm:flex-nowrap">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 shrink-0"
                checked={allChecked}
                onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])}
                title="全选本页"
              />
              <span className="w-[44px] shrink-0">全选</span>
              <button
                className="w-24 shrink-0 text-left text-[11px] text-slate-500 hover:text-blue-600"
                onClick={() => setSort(sort === 'code_desc' ? 'code_asc' : 'code_desc')}
                title="点一下切换：编号从大到小 / 从小到大"
              >
                编号 {sort === 'code_asc' ? '↑' : '↓'}
              </button>
              <span className="min-w-0 flex-1">产品 / 评估结论</span>
              <span className="w-24 shrink-0">评级</span>
              <span className="w-16 shrink-0">审核</span>
              <span className="w-24 shrink-0">更新</span>
              <span className="w-[220px] shrink-0">操作</span>
            </div>

            {rows.map((r) => {
              const status = STATUS_TEXT[r.evalReview ?? '']
              return (
                <div
                  key={r.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3 py-2 transition-colors sm:flex-nowrap',
                    selected.includes(r.id)
                      ? 'border-blue-400 ring-1 ring-blue-200'
                      : 'border-slate-200 hover:border-slate-300'
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 shrink-0"
                    checked={selected.includes(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                  <div className="shrink-0">
                    <ScoreDot score={r.evalScore ?? 0} />
                  </div>
                  <div className="w-24 shrink-0">
                    {r.code ? (
                      <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-white">{r.code}</span>
                    ) : (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">历史草稿</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-slate-800">{r.title || '(未命名)'}</div>
                    <div className="truncate text-[11px] text-slate-500">{r.evalSummary || '（无摘要）'}</div>
                  </div>
                  <div className="w-24 shrink-0">
                    <VerdictBadge verdict={(r.evalVerdict as 'GO' | 'MAYBE' | 'NO' | null) ?? null} />
                  </div>
                  <div className="w-16 shrink-0">
                    {status ? (
                      <Badge variant="outline" className={status.cls}>
                        {status.label}
                      </Badge>
                    ) : (
                      <span className="text-[11px] text-slate-400">—</span>
                    )}
                  </div>
                  <div className="w-24 shrink-0 text-[11px] text-slate-400">
                    {new Date(r.updatedAt).toLocaleDateString('zh-CN')}
                  </div>
                  <div className="flex w-[220px] shrink-0 flex-wrap items-center gap-1">
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setOpenRow(r)}>
                      详情
                    </Button>
                    {r.productId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px] text-slate-600"
                        onClick={() => navigate(`/listing/${r.productId}`)}
                      >
                        产品档案
                      </Button>
                    )}
                    {r.productId && r.evalReview !== 'approved' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px] text-emerald-700"
                        disabled={busy}
                        onClick={() => void decideOne(r, 'approve')}
                      >
                        通过评估
                      </Button>
                    )}
                    {r.productId && r.evalReview === 'approved' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px] text-rose-600"
                        disabled={busy}
                        title="误点了通过？点这里退回「等审核」，文案不会丢"
                        onClick={async () => {
                          if (!window.confirm('把这条撤回「等审核」？产品会退回 listing 待审核中心重新审，已生成的文案不会丢。')) return
                          try {
                            const rr = await api.revertToReview([r.productId as string])
                            if (rr.skipped.length) toast.error(rr.skipped[0].reason)
                            else toast.success('已撤回，去「listing 待审核中心」重新审核')
                            qc.invalidateQueries({ queryKey: ['evaluations'] })
                            qc.invalidateQueries({ queryKey: ['flow-overview'] })
                          } catch (err) {
                            toast.error(getErrorMessage(err))
                          }
                        }}
                      >
                        撤回审核
                      </Button>
                    )}
                    {r.productId && r.evalReview !== 'rejected' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px] text-slate-500"
                        disabled={busy}
                        onClick={() => void decideOne(r, 'reject')}
                      >
                        待定
                      </Button>
                    )}
                    {!r.productId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px] text-blue-600"
                        onClick={async () => {
                          try {
                            const rr = await api.createProductFromDraft(r.id)
                            toast.success('已建产品档案，可在产品流水线继续')
                            qc.invalidateQueries({ queryKey: ['evaluations'] })
                            qc.invalidateQueries({ queryKey: ['flow-overview'] })
                            navigate(`/listing/${rr.productId}`)
                          } catch (err) {
                            toast.error(getErrorMessage(err))
                          }
                        }}
                      >
                        建产品档案
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>


      {openRow && <EvalDetailDrawer row={openRow} onClose={() => setOpenRow(null)} onDecide={decideOne} busy={busy} />}
    </div>
  )
}

/** 评估详情抽屉：分数大圈 + 完整评估（优缺点/改善建议/风险/市场同款） */
function EvalDetailDrawer({
  row,
  onClose,
  onDecide,
  busy,
}: {
  row: EvaluationRow
  onClose: () => void
  onDecide: (row: EvaluationRow, decision: 'approve' | 'reject') => void
  busy: boolean
}) {
  const navigate = useNavigate()
  const productQuery = useQuery({
    queryKey: ['eval-detail-product', row.productId],
    queryFn: () => api.getProduct(row.productId as string),
    enabled: Boolean(row.productId),
  })
  const draftQuery = useQuery({
    queryKey: ['eval-detail-draft', row.draftId],
    queryFn: () => api.getEvaluationDraft(row.draftId as string),
    enabled: !row.productId && Boolean(row.draftId),
  })

  const loading = productQuery.isLoading || draftQuery.isLoading
  const evaluation: Evaluation | null = (() => {
    if (row.productId) return (productQuery.data as Product | undefined)?.evaluation ?? null
    const d = draftQuery.data?.evaluation
    if (!d) return null
    return (typeof d === 'string' ? JSON.parse(d) : d) as Evaluation
  })()
  const sourceUrl =
    (row.productId ? (productQuery.data as Product | undefined)?.source.sourceUrl : undefined) || row.sourceUrl

  const Section = ({ title, items, tone }: { title: string; items?: string[]; tone?: string }) => {
    if (!items?.length) return null
    return (
      <div>
        <div className={cn('text-[12px] font-semibold', tone ?? 'text-slate-700')}>{title}</div>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-slate-600">
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-2xl flex-col overflow-hidden bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-slate-100 px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {row.code && (
                <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[11px] text-white">{row.code}</span>
              )}
              <span className="truncate text-sm font-semibold text-slate-900">{row.title || '(未命名)'}</span>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-500">
              评估时间：{row.evalReviewedAt ? new Date(row.evalReviewedAt).toLocaleString('zh-CN') : new Date(row.updatedAt).toLocaleString('zh-CN')}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-sm text-slate-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载评估…
            </div>
          ) : !evaluation ? (
            <div className="py-16 text-center text-sm text-slate-500">这条记录没有完整的评估数据</div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                <ScoreRing score={evaluation.score ?? 0} />
                <div className="min-w-0 flex-1">
                  <VerdictBadge verdict={evaluation.verdict ?? null} score={evaluation.score} />
                  {evaluation.scoreNote && <p className="mt-1 text-[11px] text-slate-500">{evaluation.scoreNote}</p>}
                  <p className="mt-1.5 text-[12px] leading-relaxed text-slate-700">{evaluation.summary || '（无摘要）'}</p>
                  {sourceUrl && (
                    <a
                      href={sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-blue-600 hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" /> 1688 来源
                    </a>
                  )}
                </div>
              </div>

              {evaluation.scoreBreakdown && (
                <div className="grid grid-cols-5 gap-2">
                  {(
                    [
                      ['差异化', evaluation.scoreBreakdown.differentiation],
                      ['可定制', evaluation.scoreBreakdown.customization],
                      ['物流', evaluation.scoreBreakdown.shipping],
                      ['竞争', evaluation.scoreBreakdown.competition],
                      ['合规', evaluation.scoreBreakdown.compliance],
                    ] as Array<[string, number]>
                  ).map(([label, v]) => (
                    <div key={label} className="rounded-lg border border-slate-200 px-2 py-1.5 text-center">
                      <div className="text-[10px] text-slate-500">{label}</div>
                      <div className="text-sm font-semibold text-slate-800">{v}</div>
                    </div>
                  ))}
                </div>
              )}

              <Section title="优点" items={evaluation.pros} tone="text-emerald-700" />
              <Section title="缺点 / 风险" items={[...(evaluation.cons ?? []), ...(evaluation.risks ?? [])]} tone="text-rose-700" />
              <Section title="问题点" items={evaluation.issues} tone="text-amber-700" />
              <Section title="改善建议" items={evaluation.suggestions} tone="text-blue-700" />
              <Section title="目标买家" items={evaluation.buyers} />
              <Section title="适用场景" items={evaluation.occasions} />
              <Section title="建议渠道" items={evaluation.channels} />
              <Section title="Listing 钩子" items={evaluation.listingHooks} />
              {evaluation.priceAdviceUsd && (
                <div className="text-[12px] text-slate-600">
                  <span className="font-semibold text-slate-700">建议售价：</span>${evaluation.priceAdviceUsd.min} – $
                  {evaluation.priceAdviceUsd.max}
                </div>
              )}
              {evaluation.marketSnapshot && <MarketEvidenceBlock snap={evaluation.marketSnapshot} />}
              {!evaluation.marketSnapshot && evaluation.marketError ? (
                <div className="text-[11px] text-amber-700">海外同款没取到：{evaluation.marketError}</div>
              ) : null}
              {evaluation.sourcingTips && (
                <div className="text-[12px] text-slate-600">
                  <span className="font-semibold text-slate-700">采购建议：</span>
                  {evaluation.sourcingTips}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3">
          {row.productId && (
            <>
              <Button size="sm" disabled={busy || row.evalReview === 'approved'} onClick={() => onDecide(row, 'approve')}>
                <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 通过评估并生成文案
              </Button>
              <Button size="sm" variant="outline" disabled={busy || row.evalReview === 'rejected'} onClick={() => onDecide(row, 'reject')}>
                标为待定
              </Button>
              <Button size="sm" variant="ghost" className="text-slate-600" onClick={() => navigate(`/listing/${row.productId}`)}>
                打开产品档案
              </Button>
            </>
          )}
          {!row.productId && (
            <Button
              size="sm"
              onClick={async () => {
                try {
                  const rr = await api.createProductFromDraft(row.id)
                  navigate(`/listing/${rr.productId}`)
                } catch (err) {
                  toast.error(getErrorMessage(err))
                }
              }}
            >
              建产品档案
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 列表里用的小分数圈：40px，颜色按分数分段，和详情里的大圈同一套口径 */
function ScoreDot({ score }: { score: number }) {
  const s = Math.max(0, Math.min(100, Math.round(score)))
  const color = s >= 75 ? 'text-emerald-500' : s >= 55 ? 'text-amber-500' : 'text-rose-500'
  const circumference = 2 * Math.PI * 16
  const offset = circumference - (s / 100) * circumference
  return (
    <div className="relative h-10 w-10 shrink-0" title={`评估分 ${s}`}>
      <svg className="h-full w-full -rotate-90" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="4" className="text-slate-200" />
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={color}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={cn('text-[12px] font-bold', color)}>{s}</span>
      </div>
    </div>
  )
}
