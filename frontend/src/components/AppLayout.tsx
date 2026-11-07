import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  ClipboardCheck,
  Compass,
  Database,
  FolderOpen,
  Layers,
  LayoutDashboard,
  Package,
  SearchCheck,
  Settings as SettingsIcon,
  ShoppingBag,
  Sparkles,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * 导航按「干什么活」分组，而不是按功能模块平铺。
 * 一个产品从录入到上架的路径就是从上往下走：
 *   工作总览 → 产品流水线 → 录入与选品 → 批量生产 → 审核与上架
 */
const NAV_GROUPS: Array<{
  title: string
  items: Array<{ to: string; label: string; icon: React.ElementType; end?: boolean; badge?: 'flow' | 'review' }>
}> = [
  {
    title: '工作台',
    items: [
      { to: '/', label: '工作总览', icon: LayoutDashboard, end: true },
      { to: '/pipeline', label: '产品流水线', icon: Layers, badge: 'flow' },
    ],
  },
  {
    title: '录入与选品',
    items: [
      { to: '/sourcing-suggest', label: '选品预估', icon: Compass },
      { to: '/sourcing', label: '产品信息预填', icon: SearchCheck },
      { to: '/evaluations', label: '评估库', icon: FolderOpen },
      { to: '/master-data', label: '产品资料库', icon: Database },
    ],
  },
  {
    title: '批量生产',
    items: [{ to: '/batch', label: '批量处理', icon: Layers }],
  },
  {
    title: '审核与上架',
    items: [
      { to: '/listing-reviews', label: '英文链接待审核', icon: ClipboardCheck, badge: 'review' },
      { to: '/library', label: '正式产品库', icon: Package },
    ],
  },
  {
    title: '其他',
    items: [
      { to: '/order-center', label: '订单运营中心', icon: ShoppingBag },
      { to: '/settings', label: '设置', icon: SettingsIcon },
    ],
  },
]

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: '工作总览', sub: '今天该处理哪些产品、卡在哪一步、有多少待审核' },
  '/pipeline': { title: '产品流水线', sub: '一个产品一条档案（RPA 编号）：资料 → 评估 → 英文文案 → 审核 → 正式产品' },
  '/sourcing-suggest': { title: '选品预估', sub: 'AI 自动搜寻适合美国促销礼品市场的选品方向与 1688 搜索词' },
  '/sourcing': { title: '产品信息预填', sub: '粘贴 1688 链接带出商品资料，补全尺寸、材质、箱规后正式评估' },
  '/batch': { title: '批量生产', sub: '批量跑单品同一条流程：预填 → 补全 → 预估 → 评估 → 生成链接 → 入库' },
  '/listing-reviews': { title: '英文链接待审核', sub: '待审核就是产品档案里状态为「待审核」的那些：通过→正式产品库，驳回→改后重做' },
  '/master-data': { title: '产品资料库', sub: '自建主数据：链接、箱规、每箱数、毛重、多张图片录一次，之后抓取自动命中' },
  '/evaluations': { title: '评估库', sub: '选品评估草稿集中存放，随时载入继续编辑或直接生成英文链接' },
  '/library': { title: '正式产品库', sub: '审核通过的产品；可查询、修改、导出与上传 ASI ESP' },
  '/order-center': { title: '订单运营中心', sub: '客户、询盘、订单、供应商沟通与邮件草稿一站式管理' },
  '/settings': { title: '设置', sub: 'AI 接口、成本参数与报价规则' },
}

export function AppLayout() {
  const location = useLocation()
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 30_000 })
  // 导航上的角标：待处理 = 待补资料+待评估+待生成文案；待审核 = pending_review
  const { data: flow } = useQuery({
    queryKey: ['flow-overview'],
    queryFn: api.getFlowOverview,
    staleTime: 60_000,
    refetchInterval: 120_000,
  })
  const aiReady = Boolean(data?.hasApiKey)
  const meta =
    TITLES[location.pathname] ??
    (location.pathname.startsWith('/listing')
      ? { title: '链接生成与审核', sub: '资料 / 评估 / 英文文案 / 出图 都在这一个产品档案里' }
      : { title: '工作台', sub: '' })

  const badgeValue = (kind: 'flow' | 'review' | undefined): number => {
    if (!flow || !kind) return 0
    if (kind === 'review') return flow.pendingReview
    return flow.needSpecs + flow.needEval + flow.needListing + flow.needConfirm
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
