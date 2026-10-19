import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Compass,
  FolderOpen,
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

const NAV = [
  { to: '/', label: '概览', icon: LayoutDashboard, end: true },
  { to: '/sourcing-suggest', label: '选品预估', icon: Compass, end: false },
  { to: '/sourcing', label: '产品信息预填', icon: SearchCheck, end: false },
  { to: '/evaluations', label: '评估库', icon: FolderOpen, end: false },
  { to: '/library', label: '产品库', icon: Package, end: false },
  { to: '/order-center', label: '订单运营中心', icon: ShoppingBag, end: false },
  { to: '/settings', label: '设置', icon: SettingsIcon, end: false },
]

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: '工作台概览', sub: '选品进度、链接产出与利润概览' },
  '/sourcing-suggest': { title: '选品预估', sub: 'AI 自动搜寻适合美国促销礼品市场的选品方向与 1688 搜索词' },
  '/sourcing': { title: '产品信息预填', sub: '粘贴 1688 链接带出商品资料，补全尺寸、材质、箱规后正式评估' },
  '/evaluations': { title: '评估库', sub: '选品评估草稿集中存放，随时载入继续编辑' },
  '/library': { title: '产品库', sub: '所有已保存的选品与生成的英文链接' },
  '/order-center': { title: '订单运营中心', sub: '客户、询盘、订单、供应商沟通与邮件草稿一站式管理' },
  '/settings': { title: '设置', sub: 'AI 接口、成本参数与报价规则' },
}

export function AppLayout() {
  const location = useLocation()
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 30_000 })
  const aiReady = Boolean(data?.hasApiKey)
  const meta =
    TITLES[location.pathname] ??
    (location.pathname.startsWith('/listing')
      ? { title: '链接生成', sub: '把选品变成可直接上架的英文产品链接' }
      : { title: '工作台', sub: '' })

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

        <nav className="mt-2 flex flex-col gap-1 px-3">
          {NAV.map((item) => (
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
              {item.label}
            </NavLink>
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
