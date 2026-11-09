import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Archive,
  ClipboardCheck,
  Compass,
  Database,
  FolderOpen,
  Layers,
  LayoutDashboard,
  Package,
  Settings as SettingsIcon,
  ShoppingBag,
  Sparkles,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * 导航按「一个产品从进来到上架」的真实顺序排：
 *   工作总览 → 产品流水线 → 选品预估 → 产品资料库 → 评估库 → listing 待审核中心
 *   → 预产品库 → RPA 档案库 → 订单运营中心 → 设置
 * 合并后不再有「产品资料卡 / Listing 审核中心 / 批量处理」这些重复入口：
 * 资料卡并入产品资料库，审核并入 listing 待审核中心，批量任务在对应页里点。
 */
const NAV_GROUPS: Array<{
  title: string
  items: Array<{
    to: string
    label: string
    icon: React.ElementType
    end?: boolean
    /** 红色数字角标：显示「这一步还有几条要处理」 */
    badge?: 'specs' | 'evalReview' | 'review'
  }>
}> = [
  {
    title: '工作流程',
    items: [
      { to: '/', label: '工作总览', icon: LayoutDashboard, end: true },
      // 产品流水线是总览页，不挂数字（各步的数字挂到对应的功能页上）
      { to: '/pipeline', label: '产品流水线', icon: Layers },
      { to: '/sourcing-suggest', label: '选品预估', icon: Compass },
      { to: '/master-data', label: '产品资料库', icon: Database, badge: 'specs' },
      { to: '/evaluations', label: '评估库', icon: FolderOpen, badge: 'evalReview' },
      { to: '/listing-reviews', label: 'listing 待审核中心', icon: ClipboardCheck, badge: 'review' },
      { to: '/library', label: '预产品库', icon: Package },
      { to: '/rpa', label: 'RPA 档案库', icon: Archive },
    ],
  },
  {
    title: '其他',
    items: [
      { to: '/order-center', label: '订单运营中心', icon: ShoppingBag },
      { to: '/visual-styles', label: '视觉风格中心', icon: Sparkles },
      { to: '/settings', label: '设置', icon: SettingsIcon },
    ],
  },
]

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: '工作总览', sub: '今天该处理哪些产品、卡在哪一步、有多少待审核' },
  '/pipeline': { title: '产品流水线', sub: '一个产品一条档案：资料 → 评估 → 评估审核 → 英文文案 → 文案审核 → 预产品库 → RPA 档案库' },
  '/sourcing-suggest': { title: '选品预估', sub: 'AI 自动搜寻适合美国促销礼品市场的选品方向与 1688 搜索词（单个产品预估也在这）' },
  '/master-data': { title: '产品资料库', sub: '批量导入产品资料（导入即进系统）、每产品一张资料卡、批量推进到产品评估' },
  '/evaluations': { title: '评估库', sub: '所有评估过的产品都在这：看优缺点与改善建议，批量决定通过（自动去生成文案）还是待定' },
  '/listing-reviews': { title: 'listing 待审核中心', sub: '批量生成的草稿 + 流水线里待审核的文案，都在这一页审：通过进预产品库，驳回可改' },
  '/visual-styles': { title: '视觉风格中心', sub: '参考图库 + AI 学到的风格配置：出图时自动匹配，日常不用再找参考图、重写提示词' },
  '/library': { title: '预产品库', sub: '审核通过、已发 GLS 编号的产品；可导出上传 ASI，也可挑出来送进 RPA 档案库换号' },
  '/rpa': { title: 'RPA 档案库', sub: '从预产品库挑出来、人工重新赋号的产品（旧 GLS 号留存、不再复用）' },
  '/order-center': { title: '订单运营中心', sub: '客户、询盘、订单、供应商沟通与邮件草稿一站式管理' },
  '/settings': { title: '设置', sub: 'AI 接口、模型分工、成本参数与数据维护' },
  '/sourcing': { title: '产品信息预填', sub: '粘贴 1688 链接带出商品资料，补全尺寸、材质、箱规后正式评估' },
  '/batch': { title: '批量导入处理', sub: '批量跑单品同一条流程：预填 → 补全 → 预估 → 评估 → 生成链接 → 入库' },
  '/production': { title: '批次进度', sub: '批量评估 / 批量生成文案的后台任务进度（可暂停、继续、重试失败项）' },
}

export function AppLayout() {
  const location = useLocation()
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 30_000 })
  // 导航上的角标：待处理 = 待补资料+待评估+待生成文案；待审核 = pending_review
  const { data: flow } = useQuery({
    queryKey: ['flow-overview'],
    queryFn: api.getFlowOverview,
    staleTime: 10_000,
    refetchInterval: 15_000,
  })
  const aiReady = Boolean(data?.hasApiKey)
  const meta =
    TITLES[location.pathname] ??
    (location.pathname.startsWith('/listing')
      ? { title: '链接生成与审核', sub: '资料 / 评估 / 英文文案 / 出图 都在这一个产品档案里' }
      : { title: '工作台', sub: '' })

  // 数字角标挂到「这一步的处理页面」上：
  //   产品资料库 = 待补资料；评估库 = 评估等人工定结论；listing 待审核 = 文案等审核
  const badgeValue = (kind: 'specs' | 'evalReview' | 'review' | undefined): number => {
    if (!flow || !kind) return 0
    if (kind === 'specs') return flow.needSpecs ?? 0
    if (kind === 'evalReview') return flow.needEvalReview ?? 0
    return flow.pendingReview ?? 0
  }

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      <aside className="hidden w-60 shrink-0 flex-col bg-slate-900 text-slate-100 md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">ASI 选品工作台</div>
            <div className="text-[11px] text-slate-400">1688 → 美国促销礼品</div>
          </div>
        </div>

        <nav className="mt-1 flex flex-col gap-3 overflow-y-auto px-3 pb-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                {group.title}
              </div>
              <div className="flex flex-col gap-1">
                {group.items.map((item) => {
                  const n = badgeValue(item.badge)
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                          isActive
                            ? 'bg-blue-600 text-white'
                            : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                        )
                      }
                    >
                      <item.icon className="h-4 w-4" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {n > 0 && (
                        <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          {n > 99 ? '99+' : n}
                        </span>
                      )}
                    </NavLink>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="mt-auto p-4">
          <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
            <div className="flex items-center gap-2 text-xs">
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  aiReady ? 'bg-emerald-400' : 'bg-amber-400'
                )}
              />
              <span className="font-medium">AI {aiReady ? '已接入' : '未配置'}</span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
              {aiReady
                ? data?.settings.aiModel
                : '到设置页填写 API Key 后启用智能生成'}
            </p>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-slate-200 bg-white px-6 py-4">
          <h1 className="text-lg font-semibold tracking-tight">{meta.title}</h1>
          <p className="mt-0.5 text-sm text-slate-500">{meta.sub}</p>
        </header>

        <main className="min-w-0 flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
