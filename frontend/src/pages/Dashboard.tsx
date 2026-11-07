import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Layers,
  Loader2,
  SearchCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { useSettings } from '@/hooks/use-data'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { FlowNextStep } from '@/types'

const NEXT_LABEL: Record<FlowNextStep, string> = {
  specs: '待补资料',
  evaluate: '待评估',
  listing: '待生成文案',
  confirm: '待确认保存',
  review: '待审核',
  done: '已完成',
  rejected: '已驳回',
  trashed: '回收站',
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
  onClick,
}: {
  label: string
  value: string | number
  hint: string
  icon: React.ElementType
  tone: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-colors hover:border-blue-300"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <Icon className={cn('h-4 w-4', tone)} />
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight">{value}</div>
      <p className="mt-1 text-xs text-slate-400">{hint}</p>
    </button>
  )
}

/**
 * 工作总览：不展示花活指标，只回答一个问题 —— 现在哪几条产品卡住了、下一步点哪儿。
 */
export default function Dashboard() {
  const navigate = useNavigate()
  const { data: settings } = useSettings()
  const flowQ = useQuery({ queryKey: ['flow-overview'], queryFn: api.getFlowOverview })
  const todoQ = useQuery({
    queryKey: ['flow-products', 'open'],
    queryFn: () => api.listFlowProducts({ need: 'open', limit: 8 }),
  })
  const flow = flowQ.data
  const todos = todoQ.data?.rows ?? []

  return (
    <div className="space-y-6">
      {settings && !settings.hasApiKey && (
        <Alert className="border-amber-200 bg-amber-50">
          <Sparkles className="h-4 w-4 text-amber-600" />
          <AlertTitle className="text-amber-900">还未接入 AI</AlertTitle>
          <AlertDescription className="text-amber-800">
            现在选品评估走的是本地规则引擎（只有评分和风险提示）。到
            <Link to="/settings" className="mx-1 font-medium underline">
              设置
            </Link>
            填入 API Key，就能生成完整的英文标题、描述、关键词和买家画像。
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="待补资料"
          value={flow?.needSpecs ?? 0}
          hint="缺箱规/尺寸/重量，补完才能评估"
          icon={TriangleAlert}
          tone="text-amber-600"
          onClick={() => navigate('/pipeline')}
        />
        <StatCard
          label="待评估"
          value={flow?.needEval ?? 0}
          hint="资料齐了，还没跑 AI 评估"
          icon={Sparkles}
          tone="text-sky-600"
          onClick={() => navigate('/pipeline')}
        />
        <StatCard
          label="待生成文案"
          value={(flow?.needListing ?? 0) + (flow?.needConfirm ?? 0)}
          hint="已评估，等英文标题/卖点/描述"
          icon={FileText}
          tone="text-violet-600"
          onClick={() => navigate('/pipeline')}
        />
        <StatCard
          label="待审核"
          value={flow?.pendingReview ?? 0}
          hint="文案已生成，等你核对"
          icon={ClipboardCheck}
          tone="text-rose-600"
          onClick={() => navigate('/listing-reviews')}
        />
        <StatCard
          label="正式产品"
          value={flow?.listed ?? 0}
          hint="审核通过，可直接上传 ESP"
          icon={CheckCircle2}
          tone="text-emerald-600"
          onClick={() => navigate('/library')}
        />
        <StatCard
          label="产品档案"
          value={flow?.total ?? 0}
          hint={`其中 ${flow?.withImages ?? 0} 条出了 AI 图`}
          icon={Layers}
          tone="text-slate-600"
          onClick={() => navigate('/pipeline')}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">现在还没做完的产品</h3>
            <Button variant="ghost" size="sm" onClick={() => navigate('/pipeline')}>
              打开流水线 <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
          <div className="mt-3 space-y-2">
            {todoQ.isLoading && <Skeleton className="h-24 w-full" />}
            {!todoQ.isLoading && todos.length === 0 && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
                <p className="text-sm text-slate-500">没有卡住的产品 —— 全部做完或在审核中</p>
                <Button className="mt-3" size="sm" onClick={() => navigate('/sourcing')}>
                  <SearchCheck className="mr-1 h-3 w-3" /> 去录入新产品
                </Button>
              </div>
            )}
            {todos.map((r) => (
              <button
                key={r.id}
                onClick={() => navigate(`/listing/${r.id}`)}
                className="flex w-full items-center gap-3 rounded-lg border border-slate-100 px-3 py-2.5 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/40"
              >
                <span className="shrink-0 rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-white">
                  {r.code || '—'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900">
                    {r.title || '(未命名产品)'}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-slate-500">
                    {r.specs.missing.length
                      ? `缺 ${r.specs.missing.slice(0, 4).join('/')}`
                      : r.hasEval
                        ? `评估 ${r.score ?? '—'} 分 ${r.verdict ?? ''}`
                        : '资料齐全，可评估'}
                  </div>
                </div>
                <span className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600">
                  {NEXT_LABEL[r.nextStep]}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold">一天该怎么走</h3>
          <ol className="space-y-3 text-sm text-slate-600">
            {[
              ['1', '在 1688 找到品，粘链接到「产品信息预填」，补尺寸/净重/颜色/箱规/图片。'],
              ['2', '点「AI 选品评估」+「看图找同款」，判断值不值得做。'],
              ['3', '保存后就在「产品流水线」里，勾上多条一次性批量生成英文文案。'],
              ['4', '在「英文链接待审核」逐条核对（可打开完整编辑页改文案、出图）。'],
              ['5', '通过 → 自动进正式产品库，导出上传 ASI ESP。'],
            ].map(([n, text]) => (
              <li key={n} className="flex gap-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] text-white">
                  {n}
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
          <div className="flex gap-2">
            <Button className="flex-1" size="sm" onClick={() => navigate('/sourcing')}>
              <SearchCheck className="mr-1 h-4 w-4" /> 录入产品
            </Button>
            <Button className="flex-1" size="sm" variant="outline" onClick={() => navigate('/pipeline')}>
              <Layers className="mr-1 h-4 w-4" /> 流水线
            </Button>
          </div>
          {flowQ.isFetching && (
            <p className="flex items-center gap-1 text-[11px] text-slate-400">
              <Loader2 className="h-3 w-3 animate-spin" /> 正在统计…
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
