import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Server } from 'lucide-react'
import { api } from '@/lib/api'

/**
 * 自动选品
 *
 * 重活（搜 1688、抓详情、逐条 AI 评估）放在 GitHub Actions 上跑，
 * 你的 Render 实例只负责接收结果（POST /api/products/import），不再被长请求压垮。
 */

const ACTIONS_URL = 'https://github.com/renyan11g-hash/-asi-workbench/actions/workflows/daily-sourcing.yml'

export default function SourcingDaily() {
  const { data: products } = useQuery({ queryKey: ['products', 'all'], queryFn: () => api.listProducts() })

  const auto = (products ?? []).filter((p) => p.origin === 'auto')
  const sorted = [...auto].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">怎么跑</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          搜索 1688、抓详情、逐条 AI 评估这些重活，现在都放在 <b>GitHub Actions</b> 的机器上跑，
          你的网站只负责接收结果。这样不会再出现上次那种「一个长请求把数据库连接搞挂」的情况。
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a
            href={ACTIONS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            打开 GitHub Actions 运行页
          </a>
          <span className="text-[11px] text-slate-400">
            进去点右侧「Run workflow」就是手动跑一次；不点也会每天北京时间 08:00 自动跑。
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 text-xs leading-relaxed text-slate-500">
        <div className="mb-2 flex items-center gap-1.5 font-semibold text-slate-700">
          <Server className="h-3.5 w-3.5" /> 第一次用要配两个 Secrets（只需一次）
        </div>
        <ol className="list-decimal space-y-1 pl-4">
          <li>
            打开仓库 <code className="rounded bg-slate-100 px-1">Settings → Secrets and variables → Actions</code>
          </li>
          <li>
            加 <code className="rounded bg-slate-100 px-1">SITE_URL</code> = <code className="rounded bg-slate-100 px-1">https://asi-workbench.onrender.com</code>
          </li>
          <li>
            加 <code className="rounded bg-slate-100 px-1">SYNC_TOKEN</code> = 在 Render 环境变量里也配一个同样的随机串（两个地方必须一致）
          </li>
        </ol>
        <p className="mt-2">
          流程：搜 360/搜狗 → 粗筛（跨境信号 / 支持定制 / 品牌且不能定制的跳过 / 价格 ¥0.5–150 / 去重）→ 抓详情 →
          导入网站 → 逐条 AI 评估 → 算 v2 分 → 进「审核队列」。
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-900">自动选品已导入</h3>
          <span className="text-xs text-slate-400">共 {auto.length} 条</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2">产品</th>
              <th className="px-4 py-2 text-right">采购价</th>
              <th className="px-4 py-2 text-right">v2</th>
              <th className="px-4 py-2">状态</th>
              <th className="px-4 py-2">选品理由</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-slate-400">
                  还没有自动导入的产品。配好 Secrets 后去 Actions 手动跑一次试试。
                </td>
              </tr>
            )}
            {sorted.slice(0, 50).map((p) => (
              <tr key={p.id} className="border-b border-slate-50 last:border-0">
                <td className="max-w-[320px] px-4 py-2">
                  <div className="truncate font-medium text-slate-800">
                    {p.listing?.titleZh || p.source.sourceTitle || '(未命名)'}
                  </div>
                  <div className="truncate text-[11px] text-slate-400">
                    {(p.evaluation?.asiCategories ?? []).slice(0, 2).join(' / ') || '未分类'}
                  </div>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">¥{p.source.priceCny ?? '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{p.scoreV2 ?? '—'}</td>
                <td className="px-4 py-2 text-xs text-slate-500">
                  {p.verdictV2 === 'GO' ? '可做' : p.verdictV2 === 'NEGOTIATE' ? '压价' : p.verdictV2 === 'NO' ? '做不了' : '待评估'}
                </td>
                <td className="max-w-[320px] px-4 py-2 text-[11px] text-slate-500" title={p.selectionReason ?? ''}>
                  <div className="line-clamp-2">{p.selectionReason || '—'}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
