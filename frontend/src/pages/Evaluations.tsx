import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SectionCard, VerdictBadge } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import type { EvaluationRow } from '@/types'

type Tab = 'all' | 'pending' | 'approved' | 'rejected'

const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  pending: { label: '待审核', cls: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700' },
  approved: { label: '已通过', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  rejected: { label: '待定', cls: 'border-slate-300 bg-slate-100 text-slate-600' },
}

/**
 * 评估库（2026-11-07 流程合并）。
 *
 * 这里不再是「另一份草稿」：它就是**产品档案里评估过的那批**，一人一行，
 * 能看分数/结论/优缺点/改善建议，也能直接批量决定「通过」（通过即自动去生成英文链接）
 * 还是「待定」。所以评估通过与否都能在这里筛选出来，不会丢。
 */
export default function Evaluations() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('all')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const listQuery = useQuery({
    queryKey: ['evaluations', tab, q],
    queryFn: () => api.listEvaluations({ status: tab, q: q || undefined }),
  })
  const legacyQuery = useQuery({ queryKey: ['eval-legacy-drafts'], queryFn: api.listDrafts })

  const rows = useMemo(() => listQuery.data?.rows ?? [], [listQuery.data])
  const counts = listQuery.data?.counts

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  const decide = async (decision: 'approve' | 'reject') => {
    if (!selected.length) return
    if (
      decision === 'reject' &&
      !window.confirm(`把选中的 ${selected.length} 个产品标成「待定」？评估结果会保留在评估库，之后可以改判。`)
    )
      return
    setBusy(true)
    try {
      const r = await api.evalReview({ ids: selected, decision })
      if (decision === 'approve') {
        toast.success(`已通过 ${r.changed} 条，正在自动生成英文链接（可到产品流水线看进度）`)
      } else {
        toast.success(`已标为待定 ${r.changed} 条`)
      }
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

  /** 重新评估：把选中的再跑一遍（AI 评估 + 看图找同款），跑完自动回到待审核 */
  const reevaluate = async () => {
    if (!selected.length) return
    setBusy(true)
    try {
      const { job } = await api.evaluateProducts({
        productIds: selected.slice(0, 20),
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

  const allChecked = rows.length > 0 && rows.every((r) => selected.includes(r.id))

  return (
    <div className="space-y-4">
      <SectionCard
        title="评估库"
        hint="评估跑完的产品都在这里。通过就自动进入下一步生成英文链接；不通过只是标待定，资料和评估都保留"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700">
              待审核 {counts?.pending ?? 0}
            </Badge>
            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
              已通过 {counts?.approved ?? 0}
            </Badge>
            <Badge variant="outline" className="border-slate-300 bg-slate-100 text-slate-600">
              待定 {counts?.rejected ?? 0}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => void listQuery.refetch()}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
            </Button>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(
            [
              { key: 'all', label: `全部（${counts?.all ?? 0}）` },
              { key: 'pending', label: '待审核' },
              { key: 'approved', label: '已通过' },
              { key: 'rejected', label: '待定' },
            ] as Array<{ key: Tab; label: string }>
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setTab(t.key)
                setSelected([])
              }}
              className={
                tab === t.key
                  ? 'rounded-full border border-blue-300 bg-blue-50 px-3 py-1 text-[12px] font-semibold text-blue-700'
                  : 'rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-500 hover:border-slate-300'
              }
            >
              {t.label}
            </button>
          ))}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜编号 / 产品名 / 评估结论 / 链接"
              className="h-7 w-64 rounded border border-slate-200 pl-7 pr-2 text-[12px] outline-none focus:border-blue-400"
            />
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-slate-400">
              共 {rows.length} 条{selected.length ? `，已选 ${selected.length}` : ''}
            </span>
            <Button size="sm" disabled={busy || !selected.length} onClick={() => void decide('approve')}>
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 通过（自动生成文案）
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
          <div className="flex items-center justify-center py-14 text-sm text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载评估…
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-14 text-center">
            <FileText className="mx-auto mb-2 h-6 w-6 text-slate-300" />
            <p className="text-sm font-medium text-slate-600">这一类还没有产品</p>
            <p className="mt-1 text-xs text-slate-400">
              到「产品资料库」导入并推进到产品评估，或到「产品流水线」点批量评估
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-[12px]">
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
                  <th className="w-8 py-2" />
                  <th className="w-24 py-2 font-medium">编号</th>
                  <th className="py-2 font-medium">产品</th>
                  <th className="w-24 py-2 font-medium">评分</th>
                  <th className="w-44 py-2 font-medium">评估结论</th>
                  <th className="w-24 py-2 font-medium">审核</th>
                  <th className="w-40 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <EvalRow
                    key={r.id}
                    row={r}
                    checked={selected.includes(r.id)}
                    expanded={expanded === r.id}
                    onToggle={() => toggle(r.id)}
                    onExpand={() => setExpanded(expanded === r.id ? null : r.id)}
                    onOpen={() => navigate(`/listing/${r.id}`)}
                    busy={busy}
                    onDecide={(decision) => {
                      setSelected([r.id])
                      void (async () => {
                        try {
                          await api.evalReview({ ids: [r.id], decision })
                          toast.success(decision === 'approve' ? '已通过，正在生成英文链接' : '已标为待定')
                          qc.invalidateQueries({ queryKey: ['evaluations'] })
                          qc.invalidateQueries({ queryKey: ['flow-overview'] })
                        } catch (err) {
                          toast.error(getErrorMessage(err))
                        } finally {
                          setSelected([])
                        }
                      })()
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* 历史草稿：老流程留下的、还没进产品档案的评估草稿，别丢 */}
      {(legacyQuery.data?.length ?? 0) > 0 && (
        <SectionCard
          title="历史评估草稿（老数据）"
          hint="这些是改版前存在评估库里的草稿；关联了产品的已经在上面的列表里，这里只列没进产品的"
        >
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {(legacyQuery.data ?? []).slice(0, 50).map((d) => (
              <div key={d.id} className="flex items-center gap-2 rounded border border-slate-100 px-2 py-1 text-[12px]">
                <span className="truncate text-slate-700">{d.title || '(未命名草稿)'}</span>
                <span className="ml-auto shrink-0 text-[11px] text-slate-400">
                  {new Date(d.updatedAt).toLocaleDateString('zh-CN')}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={async () => {
                    try {
                      const r = await api.createProductFromDraft(d.id)
                      navigate(`/listing/${r.productId}`)
                    } catch (err) {
                      toast.error(getErrorMessage(err))
                    }
                  }}
                >
                  进入产品档案
                </Button>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  )
}

function EvalRow({
  row,
  checked,
  expanded,
  onToggle,
  onExpand,
  onOpen,
  onDecide,
  busy,
}: {
  row: EvaluationRow
  checked: boolean
  expanded: boolean
  onToggle: () => void
  onExpand: () => void
  onOpen: () => void
  onDecide: (decision: 'approve' | 'reject') => void
  busy: boolean
}) {
  const status = STATUS_TEXT[row.evalReview ?? ''] ?? { label: '未审核', cls: 'border-slate-200 bg-slate-50 text-slate-500' }
  return (
    <>
      <tr className="border-b border-slate-50 align-top">
        <td className="py-2">
          <input type="checkbox" className="h-3.5 w-3.5" checked={checked} onChange={onToggle} />
        </td>
        <td className="py-2">
          <button onClick={onExpand} className="text-slate-400 hover:text-slate-700">
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </td>
        <td className="py-2">
          <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-white">{row.code || '—'}</span>
          {row.libraryState === 'rpa' && (
            <div className="mt-0.5 rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">RPA</div>
          )}
        </td>
        <td className="max-w-[320px] py-2 pr-2">
          <div className="line-clamp-2 font-medium text-slate-800">{row.title || '(未命名)'}</div>
          <div className="mt-0.5 line-clamp-1 text-[11px] text-slate-500">{row.evalSummary}</div>
        </td>
        <td className="py-2">
          <VerdictBadge verdict={(row.verdict as 'GO' | 'MAYBE' | 'NO' | null) ?? null} score={row.score ?? undefined} />
        </td>
        <td className="py-2 pr-2">
          <div className="line-clamp-2 text-[11px] text-slate-600">{row.evalSummary || '—'}</div>
        </td>
        <td className="py-2">
          <Badge variant="outline" className={status.cls}>
            {status.label}
          </Badge>
        </td>
        <td className="py-2">
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={onOpen}>
              详情
            </Button>
            {row.evalReview !== 'approved' && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px] text-emerald-700"
                disabled={busy}
                onClick={() => onDecide('approve')}
              >
                通过
              </Button>
            )}
            {row.evalReview !== 'rejected' && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px] text-slate-500"
                disabled={busy}
                onClick={() => onDecide('reject')}
              >
                待定
              </Button>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50/60">
          <td colSpan={8} className="px-3 py-2 text-[11px] text-slate-600">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="font-medium text-slate-700">评估结论</div>
                <p className="mt-0.5 whitespace-pre-wrap">{row.evalSummary || '—'}</p>
                {row.evalBuyers.length > 0 && (
                  <p className="mt-1 text-slate-500">目标买家：{row.evalBuyers.join('、')}</p>
                )}
              </div>
              <div className="space-y-1.5">
                {row.evalPros.length > 0 && (
                  <div>
                    <span className="font-medium text-emerald-700">优点</span>
                    <ul className="mt-0.5 list-disc pl-4">
                      {row.evalPros.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {row.evalCons.length > 0 && (
                  <div>
                    <span className="font-medium text-rose-700">缺点</span>
                    <ul className="mt-0.5 list-disc pl-4">
                      {row.evalCons.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {row.evalSuggestions.length > 0 && (
                  <div>
                    <span className="font-medium text-blue-700">改善建议</span>
                    <ul className="mt-0.5 list-disc pl-4">
                      {row.evalSuggestions.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-2 border-t border-slate-200 pt-1.5">
              <span className="font-medium text-slate-700">下一步：</span>
              {row.evalReview === 'approved'
                ? row.hasListing
                  ? '评估已通过、文案已生成，去「listing 待审核中心」审核'
                  : '评估已通过，正在生成英文链接（可到产品流水线看进度）'
                : row.evalReview === 'rejected'
                  ? '已标待定：不进入生成流程，随时可以改判'
                  : '等人工决定：通过就自动生成英文链接，不通过就待定'}
              {row.sourceUrl && (
                <a
                  href={row.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 inline-flex items-center gap-0.5 text-blue-600 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" /> 1688 来源
                </a>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
