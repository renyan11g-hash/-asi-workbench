import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'

/**
 * 自动选品
 *
 * 手动触发：填「想找什么」→ 选数量 → 开始。留空则按内置品类池轮换。
 * 自动触发：由 GitHub Actions 每天北京时间 08:00 调同一个接口（见页面底部说明）。
 *
 * 粗筛刻意放宽：只要不是「自带 logo 且完全不能定制」「价格离谱」就进候选，
 * 剩下交给 v2 评分 + 人工审核。
 */

type Result = Awaited<ReturnType<typeof api.runDailySourcing>>

/**
 * 临时开关：每日选品的接口在免费实例上会占用较多内存（实测触发过一次数据库连接中断），
 * 加固完成前先禁用按钮，避免误点把站点打挂。
 */
const DAILY_ENABLED = false

export default function SourcingDaily() {
  const [prompt, setPrompt] = useState('')
  const [limit, setLimit] = useState(5)
  const [result, setResult] = useState<Result | null>(null)
  const [err, setErr] = useState('')
  const qc = useQueryClient()

  const run = useMutation({
    mutationFn: () => api.runDailySourcing({ prompt: prompt.trim() || undefined, limit }),
    onSuccess: (r) => {
      setResult(r)
      setErr('')
      qc.invalidateQueries({ queryKey: ['products'] })
    },
    onError: (e: any) => {
      setErr(e?.response?.data?.message || e?.message || '执行失败')
      setResult(null)
    },
  })

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">立即选一次</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          留空 = 按内置品类池轮换（每天不同方向）。填了要求 = 先让 AI 把要求拆成 1688 搜索词再去找。
          整个流程：搜 1688 → 粗筛（跨境信号 / 支持定制 / 价格不离谱 / 去重）→ 抓详情 → AI 评估 → 进审核队列。
        </p>

        <textarea
          className="mt-3 w-full rounded-lg border border-slate-200 p-2.5 text-sm"
          rows={3}
          placeholder="例如：适合秋季企业礼品、体积小、单价 30 元以内的杯子类；或：宠物用品里能印 logo 的"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="text-xs text-slate-500">
            本次最多新建
            <select
              className="ml-1 rounded-md border border-slate-200 px-2 py-1 text-xs"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {[3, 5, 8, 10].map((n) => (
                <option key={n} value={n}>
                  {n} 条
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={() => run.mutate()}
            disabled={run.isPending || !DAILY_ENABLED}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {!DAILY_ENABLED
              ? '加固中，暂不可用'
              : run.isPending
                ? '正在搜 1688 并评估，可能需要 1-3 分钟…'
                : '开始选品'}
          </button>

          {!DAILY_ENABLED && (
            <span className="text-[11px] text-amber-600">
              接口正在加固（上次试跑导致数据库连接中断约 10 分钟，已恢复、数据无损）。先看下面的流程说明。
            </span>
          )}

          <span className="text-[11px] text-slate-400">
            会消耗 AI 额度：每个候选一次评估调用（约 ¥0.02-0.05/条）
          </span>
        </div>

        {err && <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">{err}</div>}
      </div>

      {result && (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h3 className="text-sm font-semibold text-slate-900">本次结果</h3>
            <span className="text-xs text-slate-500">
              搜索词（{result.keywordSource}）：{result.keywords.join('、')}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="text-[11px] text-slate-500">搜到</div>
              <div className="text-xl font-semibold">{result.scanned}</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="text-[11px] text-slate-500">粗筛后候选</div>
              <div className="text-xl font-semibold">{result.candidates}</div>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <div className="text-[11px] text-emerald-700">新建入库</div>
              <div className="text-xl font-semibold text-emerald-700">{result.created.length}</div>
            </div>
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="text-[11px] text-slate-500">跳过</div>
              <div className="text-xl font-semibold">{result.skipped.length}</div>
            </div>
          </div>

          {result.created.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-xs font-medium text-slate-700">新建的候选（已进审核队列）</div>
              <ul className="space-y-2">
                {result.created.map((c) => (
                  <li key={c.id} className="rounded-lg border border-slate-200 p-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-slate-800">{c.title || '(无标题)'}</span>
                      <span className="shrink-0 text-xs text-slate-500">
                        ¥{c.priceCny ?? '—'} · AI 分 {c.score ?? '—'}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] leading-relaxed text-slate-500">{c.reason}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.skipped.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs text-slate-500">跳过的 {result.skipped.length} 条及原因</summary>
              <ul className="mt-2 space-y-1">
                {result.skipped.map((s, i) => (
                  <li key={i} className="truncate text-[11px] text-slate-500">
                    · {s.reason} — {s.url}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-5 text-xs leading-relaxed text-slate-500">
        <div className="mb-1 font-semibold text-slate-700">关于每天自动跑</div>
        <p>
          上面这个按钮和「每天 08:00 自动跑」调用的是同一个接口（<code className="rounded bg-slate-100 px-1">POST /api/products/sourcing/daily</code>）。
          定时部分我会用 GitHub Actions 挂在仓库上，这样不依赖 Render 是否在线。
          自动跑时不带要求，用内置品类池轮换；你手动填的要求只影响这一次。
        </p>
        <p className="mt-2">
          粗筛条件（按你的要求放宽）：跨境/外贸信号优先 · 支持定制（丝印/烫印/刺绣/贴牌等）· 自带品牌 logo 且完全不支持定制的直接跳过 · 价格与 1688 同行同款不离谱（¥0.5–150）· 已做过的链接自动去重。
        </p>
      </div>
    </div>
  )
}
