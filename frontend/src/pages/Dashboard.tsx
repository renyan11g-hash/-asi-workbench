import { Link } from 'react-router-dom'
import { ArrowRight, Package, SearchCheck, Sparkles, TrendingUp } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useProducts, useSettings } from '@/hooks/use-data'
import { StatusBadge, VerdictBadge } from '@/components/ui/primitives'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string
  value: string | number
  hint: string
  icon: React.ElementType
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <Icon className="h-4 w-4 text-slate-400" />
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight">{value}</div>
      <p className="mt-1 text-xs text-slate-400">{hint}</p>
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { data: settings } = useSettings()
  const { data: products, isLoading } = useProducts()

  const list = products ?? []
  const listed = list.filter((p) => p.status === 'listed').length
  const goCount = list.filter((p) => p.evaluation?.verdict === 'GO').length
  const withMargin = list.filter((p) => p.listing?.priceGrid?.length)
  const avgMargin = withMargin.length
    ? withMargin.reduce((sum, p) => sum + (p.listing?.priceGrid?.[0]?.margin ?? 0), 0) /
      withMargin.length
    : 0

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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="选品总数" value={list.length} hint="已录入的 1688 商品" icon={Package} />
        <StatCard
          label="已生成链接"
          value={listed}
          hint="可直接上架的英文 Listing"
          icon={TrendingUp}
        />
        <StatCard label="GO 级选品" value={goCount} hint="评分达到可做等级的品" icon={Sparkles} />
        <StatCard
          label="平均毛利率"
          value={withMargin.length ? `${avgMargin.toFixed(0)}%` : '—'}
          hint="按 50 件档位测算"
          icon={TrendingUp}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">最近更新</h3>
            <Button variant="ghost" size="sm" onClick={() => navigate('/library')}>
              查看全部 <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
          <div className="mt-3 space-y-2">
            {isLoading && <Skeleton className="h-24 w-full" />}
            {!isLoading && list.length === 0 && (
              <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
                <p className="text-sm text-slate-500">还没有选品记录</p>
                <Button className="mt-3" size="sm" onClick={() => navigate('/sourcing')}>
                  <SearchCheck className="mr-1 h-3 w-3" /> 去评估第一个商品
                </Button>
              </div>
            )}
            {list.slice(0, 6).map((p) => (
              <button
                key={p.id}
                onClick={() => navigate(`/listing/${p.id}`)}
                className="flex w-full items-center gap-3 rounded-lg border border-slate-100 px-3 py-2.5 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900">
                    {p.listing?.title || p.source.sourceTitle || '(未命名商品)'}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-slate-500">
                    ¥{p.source.priceCny} · MOQ {p.source.moq || '—'} ·{' '}
                    {new Date(p.updatedAt).toLocaleString('zh-CN')}
                  </div>
                </div>
                <VerdictBadge verdict={p.evaluation?.verdict} score={p.evaluation?.score} />
                <StatusBadge status={p.status} />
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold">今天怎么用</h3>
          <ol className="space-y-3 text-sm text-slate-600">
            <li className="flex gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] text-white">
                1
              </span>
              <span>在 1688 看到合适的品，复制标题、单价、重量等基本信息。</span>
            </li>
            <li className="flex gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] text-white">
                2
              </span>
              <span>到「选品评估」粘贴，AI 判断是否适合美国企业礼品市场，并给出风险提示。</span>
            </li>
            <li className="flex gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] text-white">
                3
              </span>
              <span>值得做的直接生成英文链接，含价格阶梯表，导出 CSV 上架。</span>
            </li>
          </ol>
          <Button className="w-full" onClick={() => navigate('/sourcing')}>
            <SearchCheck className="mr-1 h-4 w-4" /> 开始选品评估
          </Button>
        </div>
      </div>
    </div>
  )
}
