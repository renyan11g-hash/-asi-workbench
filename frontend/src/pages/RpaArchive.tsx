import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Archive, ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react'
import { SectionCard } from '@/components/ui/primitives'
import { api } from '@/lib/api'

/**
 * RPA 档案库：从预产品库挑出来、人工重新赋号的产品。
 *
 * 规矩（和预产品库一致）：
 *   · 新编号由人手动输入，覆盖当前编号；
 *   · 旧 GLS 号留在 prev_code 里可查，但**不再复用**（计数器只增不减）；
 *   · 这里的产品不出现在预产品库里，编号是人工号。
 */
export default function RpaArchive() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['rpa-archive', q],
    queryFn: () => api.listRpaArchive(q || undefined),
  })

  const rows = useMemo(() => data?.rows ?? [], [data])

  return (
    <div className="space-y-4">
      <SectionCard
        title="RPA 档案库"
        hint="从预产品库移进来的产品：编号是人工重新赋的，旧的 GLS 号留存、不再复用"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜编号 / 产品名 / 链接"
                className="h-8 w-60 rounded border border-slate-200 pl-7 pr-2 text-[12px] outline-none focus:border-blue-400"
              />
            </div>
            <button
              onClick={() => void refetch()}
              className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[12px] text-slate-600 hover:border-slate-300"
            >
              {isRefetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </button>
          </div>
        }
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-14 text-sm text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-14 text-center">
            <Archive className="mx-auto mb-2 h-6 w-6 text-slate-300" />
            <p className="text-sm font-medium text-slate-600">RPA 档案库还是空的</p>
            <p className="mt-1 text-xs text-slate-400">
              到「预产品库」里点某一行的「移入 RPA」，输入新编号后就会出现在这里
            </p>
            <button
              className="mt-3 rounded border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:border-blue-300"
              onClick={() => navigate('/library')}
            >
              去预产品库
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-[12px]">
              <thead className="text-[11px] text-slate-400">
                <tr className="border-b border-slate-100">
                  <th className="py-2 pr-2 font-medium">现编号</th>
                  <th className="py-2 pr-2 font-medium">原编号</th>
                  <th className="py-2 pr-2 font-medium">产品</th>
                  <th className="py-2 pr-2 font-medium">来源链接</th>
                  <th className="py-2 pr-2 font-medium">移入时间</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50 align-top">
                    <td className="py-2 pr-2">
                      <span className="rounded bg-indigo-600 px-1.5 py-0.5 font-mono text-[11px] text-white">
                        {r.code || '—'}
                      </span>
                    </td>
                    <td className="py-2 pr-2 font-mono text-[11px] text-slate-400">{r.prevCode || r.glsCode || '—'}</td>
                    <td className="max-w-[360px] py-2 pr-2">
                      <div className="line-clamp-2 text-slate-800">{r.title || '(未命名)'}</div>
                    </td>
                    <td className="py-2 pr-2">
                      {r.sourceUrl ? (
                        <a
                          href={r.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-[11px] text-blue-600 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" /> 1688
                        </a>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-[11px] text-slate-500">
                      {r.rpaArchivedAt ? new Date(r.rpaArchivedAt).toLocaleString('zh-CN') : '—'}
                    </td>
                    <td className="py-2">
                      <button
                        className="rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:border-blue-300"
                        onClick={() => navigate(`/listing/${r.id}`)}
                      >
                        打开
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 text-[11px] text-slate-400">共 {rows.length} 条</div>
          </div>
        )}
      </SectionCard>

      <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 px-4 py-3 text-[12px] leading-relaxed text-slate-600">
        <span className="font-medium text-slate-800">编号规则：</span>
        预产品库发 GLS0001、GLS0002…；移进 RPA 档案库时由你输入新编号并覆盖，旧 GLS 号会记在「原编号」里。
        号码只增不减，所以一个 GLS 号发出去之后，即使产品被移走或删除，也不会再发给别的产品。
      </div>
    </div>
  )
}
