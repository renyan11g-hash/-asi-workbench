import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Ban,
  CheckCircle2,
  CircleSlash,
  ClipboardCheck,
  Coins,
  Layers,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { ProductionItem } from '@/types'

const JOB_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  paused: '已暂停',
  done: '已完成',
  cancelled: '已取消',
  interrupted: '已中断',
}

const JOB_STYLE: Record<string, string> = {
  queued: 'border-slate-200 bg-slate-50 text-slate-600',
  running: 'border-blue-200 bg-blue-50 text-blue-700',
  paused: 'border-amber-200 bg-amber-50 text-amber-700',
  done: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  cancelled: 'border-slate-200 bg-slate-100 text-slate-500',
  interrupted: 'border-rose-200 bg-rose-50 text-rose-600',
}

const ITEM_LABEL: Record<ProductionItem['status'], string> = {
  queued: '排队',
  running: '生成中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
}

const ITEM_STYLE: Record<ProductionItem['status'], string> = {
  queued: 'text-slate-500',
  running: 'text-blue-600',
  success: 'text-emerald-600',
  failed: 'text-rose-600',
  cancelled: 'text-slate-400',
}

/**
 * 批量生产中心（第二阶段 + 第四阶段）。
 *
 * 左边选产品（一次 5~10 个），右边跑批次：每个产品独立生成、独立状态、独立错误，
 * 一条失败不影响其他条。批次状态和单条状态分开显示 —— 批次显示「3/10 完成」，
 * 条目显示各自卡在哪。
 *
 * 生成结果不会覆盖产品库里的 Listing：它先进「待审核」，人要过了才写回。
 */
export default function Production() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [only, setOnly] = useState<'all' | 'specs-ready' | 'specs-missing' | 'has-listing' | 'no-listing'>('all')
  const [selected, setSelected] = useState<string[]>([])
  const [jobId, setJobId] = useState<string | null>(() => localStorage.getItem('asi-production:jobId'))
  const [submitting, setSubmitting] = useState(false)

  const candidatesQuery = useQuery({
    queryKey: ['production-candidates', q, category, only],
    queryFn: () => api.listProductionCandidates({ q: q || undefined, category: category || undefined, only }),
  })

  const jobQuery = useQuery({
    queryKey: ['production-job', jobId],
    queryFn: () => api.getProductionJob(jobId as string),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.job.status
      return status === 'running' || status === 'queued' ? 2000 : false
    },
  })

  const jobsQuery = useQuery({ queryKey: ['production-jobs'], queryFn: () => api.listProductionJobs(8) })

  const logsQuery = useQuery({ queryKey: ['ai-logs'], queryFn: () => api.listAiCallLogs({ limit: 20 }) })

  const cards = candidatesQuery.data?.cards ?? []
  const limits = candidatesQuery.data?.limits ?? { max: 20, suggested: 10 }
  const job = jobQuery.data?.job
  const progress = jobQuery.data?.progress
  const counts = candidatesQuery.data?.counts

  // 任务跑完自动刷新一次列表（草稿进审核中心了，卡片上的「已生成」也要更新）
  useEffect(() => {
    if (job?.status === 'done' || job?.status === 'interrupted') {
      qc.invalidateQueries({ queryKey: ['production-candidates'] })
      qc.invalidateQueries({ queryKey: ['ai-logs'] })
    }
  }, [job?.status, qc])

  const toggle = (id: string) => {
    setSelected((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id)
      if (cur.length >= limits.max) {
        toast.warning(`一批最多 ${limits.max} 个产品（建议 ${limits.suggested} 个）`)
        return cur
      }
      return [...cur, id]
    })
  }

  const start = async () => {
    if (!selected.length) return
    setSubmitting(true)
    try {
      const { job: created, skipped, deduped } = await api.createProductionJob({
        kind: 'listing',
        productIds: selected,
        // 幂等键：连点两次也只会有一个批次
        clientKey: `listing-${Date.now()}-${selected.length}`,
      })
      localStorage.setItem('asi-production:jobId', created.id)
      setJobId(created.id)
      setSelected([])
      if (deduped) toast.info('这个批次已经在跑了，已切换到该批次')
      else if (skipped.length) toast.warning(`已提交 ${created.items.length} 条，跳过 ${skipped.length} 条`)
      else toast.success(`已提交 ${created.items.length} 个产品，开始逐个生成`)
      qc.invalidateQueries({ queryKey: ['production-jobs'] })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const control = async (action: 'run' | 'pause' | 'cancel' | 'retry-failed') => {
    if (!jobId) return
    // 取消是破坏性操作：先确认，再发请求
    if (action === 'cancel' && !window.confirm('取消后，还没跑的产品不再生成（已生成的草稿保留）')) return
    try {
      await api.controlProductionJob(jobId, action)
      await jobQuery.refetch()
      if (action === 'retry-failed') toast.success('已把失败的条目重新排队')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const retryItem = async (item: ProductionItem) => {
    if (!jobId) return
    try {
      await api.retryProductionItem(jobId, item.idx)
      await jobQuery.refetch()
      toast.success(`${item.code || item.title} 已重新排队`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const selectedCards = useMemo(() => cards.filter((c) => selected.includes(c.productId)), [cards, selected])
  const canStart = selected.length > 0 && !submitting

  return (
    <div className="space-y-4">
      {/* 1) 选产品 */}
      <SectionCard
        title="① 选择要生成英文 Listing 的产品"
        hint={`一次建议 ${limits.suggested} 个（最多 ${limits.max}）。每个产品独立生成，一条失败不影响其他条。`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ['production-candidates'] })}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
            </Button>
            <Button size="sm" disabled={!canStart} onClick={() => void start()}>
              {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
              开始生成{selected.length ? `（${selected.length}）` : ''}
            </Button>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜编号 / 产品名"
              className="h-9 w-60 rounded-md border border-slate-200 pl-8 pr-2 text-sm outline-none focus:border-blue-400"
            />
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-9 rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-blue-400"
          >
            <option value="">全部类别</option>
            {(candidatesQuery.data?.categories ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={only}
            onChange={(e) => setOnly(e.target.value as typeof only)}
            className="h-9 rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-blue-400"
          >
            <option value="all">全部（{counts?.all ?? 0}）</option>
            <option value="specs-ready">已有结构化资料（{counts?.specsReady ?? 0}）</option>
            <option value="specs-missing">资料有 Unknown（{counts?.specsMissing ?? 0}）</option>
            <option value="has-listing">已有 Listing（{counts?.hasListing ?? 0}）</option>
            <option value="no-listing">还没有 Listing</option>
          </select>
          <span className="ml-auto text-[11px] text-slate-400">
            已选 {selected.length} 个{selectedCards.some((c) => c.hasListing) ? '（含已有 Listing，会生成新草稿不覆盖）' : ''}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="text-xs text-slate-500"
            onClick={() => setSelected(selected.length === cards.length ? [] : cards.slice(0, limits.max).map((c) => c.productId))}
          >
            {selected.length === cards.length ? '取消全选' : `全选前 ${Math.min(cards.length, limits.max)} 个`}
          </Button>
        </div>

        {candidatesQuery.isLoading ? (
          <div className="flex items-center justify-center py-14 text-sm text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载产品…
          </div>
        ) : cards.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-12 text-center text-sm text-slate-500">
            没有符合条件的产品
          </div>
        ) : (
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full min-w-[860px] border-separate border-spacing-y-1 text-sm">
              <thead className="sticky top-0 bg-white text-left text-[11px] text-slate-400">
                <tr>
                  <th className="w-8 pl-2"> </th>
                  <th className="w-20">编号</th>
                  <th>产品</th>
                  <th className="w-20">类别</th>
                  <th className="w-28">结构化资料</th>
                  <th className="w-28">当前 Listing</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((c) => {
                  const checked = selected.includes(c.productId)
                  const pct = Math.round((c.specs.filled / c.specs.total) * 100)
                  return (
                    <tr
                      key={c.productId}
                      className={cn('cursor-pointer align-top', checked ? 'bg-blue-50/60' : 'bg-white')}
                      onClick={() => toggle(c.productId)}
                    >
                      <td className="rounded-l-lg py-2 pl-2">
                        <input type="checkbox" className="h-3.5 w-3.5" checked={checked} readOnly />
                      </td>
                      <td className="py-2">
                        <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-white">
                          {c.code || '—'}
                        </span>
                      </td>
                      <td className="py-2 pr-2">
                        <div className="line-clamp-1 text-[13px] font-medium text-slate-800">
                          {c.title || '(未命名产品)'}
                        </div>
                      </td>
                      <td className="py-2 pr-2 text-[11px] text-slate-500">{c.category || '—'}</td>
                      <td className="py-2 pr-2">
                        <div className="flex items-center gap-1.5">
                          <div className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={cn('h-full', pct === 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-400' : 'bg-slate-200')}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className={cn('text-[11px]', pct === 100 ? 'text-emerald-600' : 'text-amber-600')}>
                            {c.specs.filled}/{c.specs.total}
                          </span>
                        </div>
                      </td>
                      <td className="rounded-r-lg py-2 pr-2">
                        {c.hasListing ? (
                          <Badge variant="outline" className="border-blue-200 bg-blue-50 text-[10px] text-blue-700">
                            已有
                          </Badge>
                        ) : (
                          <span className="text-[11px] text-slate-400">未生成</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* 2) 批次进度 */}
      <SectionCard
        title="② 批次进度"
        hint="关闭浏览器不会中断：任务在后端排队执行；服务重启后点「继续」即可接着跑。"
        right={
          job ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={cn('whitespace-nowrap', JOB_STYLE[job.status])}>
                {JOB_LABEL[job.status] ?? job.status}
              </Badge>
              {(job.status === 'running' || job.status === 'queued') && (
                <Button size="sm" variant="outline" onClick={() => void control('pause')}>
                  <Pause className="mr-1 h-3.5 w-3.5" /> 暂停
                </Button>
              )}
              {(job.status === 'paused' || job.status === 'interrupted') && (
                <Button size="sm" onClick={() => void control('run')}>
                  <Play className="mr-1 h-3.5 w-3.5" /> 继续
                </Button>
              )}
              {job.items.some((i) => i.status === 'failed') && (
                <Button size="sm" variant="outline" onClick={() => void control('retry-failed')}>
                  <RotateCcw className="mr-1 h-3.5 w-3.5" /> 重试失败项
                </Button>
              )}
              {job.status !== 'done' && job.status !== 'cancelled' && (
                <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => void control('cancel')}>
                  <Ban className="mr-1 h-3.5 w-3.5" /> 取消
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => navigate('/review-center')}>
                <ClipboardCheck className="mr-1 h-3.5 w-3.5" /> 去审核
              </Button>
            </div>
          ) : undefined
        }
      >
        {!job ? (
          <div className="py-10 text-center text-sm text-slate-400">
            <Layers className="mx-auto mb-2 h-6 w-6 text-slate-300" />
            还没有批次。上面勾选产品后点「开始生成」。
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-slate-600">
                  已完成 {progress?.done ?? 0}/{progress?.total ?? 0}
                  {(progress?.failed ?? 0) > 0 && <span className="text-rose-600">，失败 {progress?.failed}</span>}
                  {progress?.current ? `　正在生成：${progress.current}` : ''}
                </span>
                <span className="font-semibold text-slate-700">{progress?.percent ?? 0}%</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    job.status === 'cancelled' ? 'bg-slate-400' : (progress?.failed ?? 0) > 0 ? 'bg-amber-500' : 'bg-emerald-500'
                  )}
                  style={{ width: `${progress?.percent ?? 0}%` }}
                />
              </div>
            </div>

            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {job.items.map((item) => (
                <div key={item.idx} className="flex items-start gap-2 px-3 py-2">
                  <div className="w-6 shrink-0 pt-0.5 text-[11px] text-slate-400">{item.idx}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                        {item.code || '—'}
                      </span>
                      <span className="truncate text-[12px] font-medium text-slate-800">{item.title}</span>
                    </div>
                    <div className={cn('mt-0.5 text-[11px]', ITEM_STYLE[item.status])}>
                      {ITEM_LABEL[item.status]}　{item.stage}
                      {item.durationMs ? `　${Math.round(item.durationMs / 1000)}s` : ''}
                    </div>
                    {item.error && <div className="mt-0.5 text-[11px] text-rose-600">失败原因：{item.error}</div>}
                    {item.qcIssues && item.qcIssues.length > 0 && (
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-amber-600">质检：{item.qcIssues.join('；')}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {item.status === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />}
                    {item.status === 'success' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
                    {item.status === 'failed' && <XCircle className="h-3.5 w-3.5 text-rose-500" />}
                    {item.status === 'cancelled' && <CircleSlash className="h-3.5 w-3.5 text-slate-400" />}
                    {(item.status === 'failed' || item.status === 'cancelled') && (
                      <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => void retryItem(item)}>
                        重试这条
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {job.status === 'done' && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
                <CheckCircle2 className="h-4 w-4" />
                这批跑完了。生成的英文 Listing 都在「审核中心」等人工核对 ——
                审核通过才会写回产品库，批量生成不会覆盖原有 Listing。
                <Button size="sm" className="ml-auto" onClick={() => navigate('/review-center')}>
                  去审核中心
                </Button>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {/* 3) 历史批次 + 调用成本 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="历史批次" hint="点一行切换查看">
          {jobsQuery.data?.jobs.length ? (
            <div className="divide-y divide-slate-100">
              {jobsQuery.data.jobs.map((j) => (
                <button
                  key={j.id}
                  onClick={() => {
                    localStorage.setItem('asi-production:jobId', j.id)
                    setJobId(j.id)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-1 py-2 text-left text-[12px] hover:bg-slate-50',
                    j.id === jobId && 'bg-blue-50/60'
                  )}
                >
                  <Badge variant="outline" className={cn('shrink-0', JOB_STYLE[j.status])}>
                    {JOB_LABEL[j.status] ?? j.status}
                  </Badge>
                  <span className="truncate">
                    {j.kind === 'spec' ? '结构化资料' : '英文 Listing'} · {j.items.length} 个产品
                  </span>
                  <span className="ml-auto shrink-0 text-slate-400">
                    {new Date(j.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-[12px] text-slate-400">还没有历史批次</div>
          )}
        </SectionCard>

        <SectionCard title="模型调用（近 24 小时）" hint="哪个任务、什么模型、几次、平均多久、多少 token">
          {logsQuery.data?.summary.length ? (
            <table className="w-full text-left text-[12px]">
              <thead className="text-[11px] text-slate-400">
                <tr>
                  <th className="py-1 font-medium">任务</th>
                  <th className="py-1 font-medium">次数</th>
                  <th className="py-1 font-medium">失败</th>
                  <th className="py-1 font-medium">平均耗时</th>
                  <th className="py-1 font-medium">token</th>
                </tr>
              </thead>
              <tbody>
                {logsQuery.data.summary.map((s) => (
                  <tr key={s.task} className="border-t border-slate-50">
                    <td className="py-1">{TASK_LABEL[s.task] ?? (s.task || '（未标注）')}</td>
                    <td className="py-1">{s.calls}</td>
                    <td className={cn('py-1', s.failed ? 'text-rose-600' : 'text-slate-400')}>{s.failed}</td>
                    <td className="py-1">{(s.avgMs / 1000).toFixed(1)}s</td>
                    <td className="py-1 text-slate-500">{s.promptTokens + s.completionTokens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-8 text-center text-[12px] text-slate-400">
              <Coins className="mx-auto mb-1 h-5 w-5 text-slate-300" />
              还没有调用记录
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  )
}

const TASK_LABEL: Record<string, string> = {
  'spec-extract': '资料结构化',
  listing: 'Listing 生成',
  'listing-qc': 'AI 复检',
  'settings-test': '连通测试',
}
