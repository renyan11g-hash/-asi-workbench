import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Product, Settings } from '@/types'
import { cn } from '@/lib/utils'

/**
 * 评分对照（v2）
 *
 * 与原评分并存：原 evaluation.score / verdict 原样展示，不动它；
 * 这里用一套可复现的规则重新打分，用来对比「AI 印象分」和「按市场价算得出来赚不赚钱」。
 *
 * v2 = 毛利分(40) + 价格空间分(30) + 物流分(10) + 品类分(20)
 */

const HOT = ['drinkware', 'bag', 'apparel', 'headwear', 'tech', 'notebook', 'pen', 'writing', 'outdoor', 'towel', 'blanket', 'fitness', 'travel']
const MID = ['home', 'houseware', 'kitchen', 'office', 'stationery', 'sport', 'pet', 'beauty', 'gift']

const hotScore = (cat: string) => {
  const c = (cat || '').toLowerCase()
  if (HOT.some((k) => c.includes(k))) return 20
  if (MID.some((k) => c.includes(k))) return 12
  return 5
}

type Verdict2 = '可做' | '压价可做' | '做不了' | '未评估'

interface Row {
  id: string
  title: string
  cat: string
  priceCny: number | null
  list: number | null
  net: number | null
  margin: number | null
  ceiling: number | null
  cut: number | null
  landedUsd: number | null
  oldScore: number | null
  oldVerdict: string
  v2: number | null
  verdict: Verdict2
  reason: string
  parts: { m: number | null; p: number | null; l: number | null; c: number }
  espQuery: string
  marketSource: string | null
}

function computeRow(p: Product, fx: number): Row {
  const grid = p.listing?.priceGrid ?? []
  const t250 = grid.find((g) => g.qty === 250) ?? grid.find((g) => g.qty >= 250) ?? grid[grid.length - 1]
  const adv = p.evaluation?.priceAdviceUsd
  const sim = p.similar?.priceRangeUsd as { min: number; max: number } | undefined

  let list: number | null = null
  if (adv && Number.isFinite(adv.min) && Number.isFinite(adv.max) && adv.max > 0) list = (adv.min + adv.max) / 2
  else if (sim && Number.isFinite(sim.min) && Number.isFinite(sim.max) && sim.max > 0) list = (sim.min + sim.max) / 2

  const priceCny = p.source?.priceCny ?? null
  const landedUsd = t250?.allInCostUsd ?? null
  const trueCny = landedUsd != null ? landedUsd * fx * 1.085 : null
  const netCny = list != null ? 0.6 * list * fx : null
  const margin = netCny && trueCny != null ? (netCny - trueCny) / netCny : null

  let ceiling: number | null = null
  if (netCny && trueCny != null && priceCny != null) ceiling = priceCny - (trueCny - netCny * 0.7)

  const freightShare =
    t250?.unitCostCny && priceCny ? Math.max(0, (t250.unitCostCny - priceCny) / t250.unitCostCny) : null

  const m = margin == null ? null : (Math.min(Math.max(margin, 0), 0.45) / 0.45) * 40
  const pScore = ceiling != null && priceCny ? Math.min(Math.max(ceiling / priceCny, 0), 1) * 30 : null
  const l =
    freightShare == null
      ? null
      : freightShare <= 0.15
        ? 10
        : freightShare >= 0.5
          ? 0
          : ((0.5 - freightShare) / 0.35) * 10
  const c = hotScore((p.evaluation?.asiCategories ?? []).join(' '))

  const v2 = m != null && pScore != null && l != null ? Math.round(m + pScore + l + c) : null

  let verdict: Verdict2 = '未评估'
  if (margin != null) {
    if (margin >= 0.3) verdict = '可做'
    else if (margin > 0 && ceiling != null && ceiling > 0) verdict = '压价可做'
    else verdict = '做不了'
  }

  const cut = ceiling != null && priceCny ? Math.max(0, (priceCny - ceiling) / priceCny) : null

  let reason = '缺报价表或市场价，无法判定'
  if (margin != null) {
    if (margin < 0) reason = `毛利 ${(margin * 100).toFixed(0)}%，零毛利也覆盖不了成本`
    else if (margin < 0.3 && ceiling != null)
      reason = `毛利 ${(margin * 100).toFixed(0)}%，压价 ${((cut ?? 0) * 100).toFixed(0)}% 到 ¥${ceiling.toFixed(1)} 可做`
    else if (ceiling != null) reason = `毛利 ${(margin * 100).toFixed(0)}%，采购价低于上限 ¥${ceiling.toFixed(1)}`
    else reason = `毛利 ${(margin * 100).toFixed(0)}%`
  }

  return {
    id: p.id,
    title: p.listing?.titleZh || p.source?.sourceTitle || p.listing?.title || '(未命名)',
    cat: (p.evaluation?.asiCategories ?? []).join(' / '),
    priceCny,
    list,
    net: list != null ? 0.6 * list : null,
    // 已经写进库里的以库为准，没写过就用页面现算的
    margin: p.marginV2 ?? margin,
    ceiling: p.ceilingCny ?? ceiling,
    cut,
    landedUsd,
    oldScore: p.evaluation?.score ?? null,
    oldVerdict: p.evaluation?.verdict ?? '未评',
    v2: p.scoreV2 ?? v2,
    verdict: p.verdictV2
      ? (({ GO: '可做', NEGOTIATE: '压价可做', NO: '做不了' } as const)[p.verdictV2])
      : verdict,
    reason,
    parts: { m, p: pScore, l, c },
    espQuery: (p.listing?.keywords?.[0] || p.listing?.title || p.source?.amazonTitle || '').slice(0, 60),
    marketSource: p.marketSource ?? null,
  }
}

const TONE: Record<Verdict2, string> = {
  可做: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  压价可做: 'bg-amber-50 text-amber-700 border-amber-200',
  做不了: 'bg-rose-50 text-rose-700 border-rose-200',
  未评估: 'bg-slate-100 text-slate-600 border-slate-200',
}

const FILTERS: Array<{ key: 'all' | Verdict2; label: string }> = [
  { key: 'all', label: '全部' },
  { key: '可做', label: '可做' },
  { key: '压价可做', label: '压价可做' },
  { key: '做不了', label: '做不了' },
  { key: '未评估', label: '未评估' },
]

export default function Rescore() {
  const [filter, setFilter] = useState<'all' | Verdict2>('all')
  const [msg, setMsg] = useState('')
  const [pricing, setPricing] = useState<{ id: string; title: string; query: string; low: string; high: string } | null>(null)
  const qc = useQueryClient()
  const { data: products, isLoading } = useQuery({ queryKey: ['products', 'all'], queryFn: () => api.listProducts() })
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 30_000 })

  const rescore = useMutation({
    mutationFn: () => api.rescoreAll(),
    onSuccess: (r) => {
      setMsg(`已写入 ${r.updated} 条：可做 ${r.counts.GO ?? 0} / 压价可做 ${r.counts.NEGOTIATE ?? 0} / 做不了 ${r.counts.NO ?? 0}`)
      qc.invalidateQueries({ queryKey: ['products'] })
    },
    onError: () => setMsg('写入失败，请稍后重试'),
  })

  const savePrice = useMutation({
    mutationFn: (v: { id: string; low: number; high: number }) => api.setMarketPrice(v.id, v.low, v.high),
    onSuccess: () => {
      setMsg('市场价已保存，v2 已按 ESP 同款价重算')
      setPricing(null)
      qc.invalidateQueries({ queryKey: ['products'] })
    },
    onError: () => setMsg('保存失败，请检查数值'),
  })

  const fx = (settings as Settings | undefined)?.fxRate || 6.66

  const rows = useMemo(() => {
    const list = (products ?? []).map((p) => computeRow(p, fx))
    list.sort((a, b) => (b.v2 ?? -1) - (a.v2 ?? -1))
    return list
  }, [products, fx])

  const counts = useMemo(() => {
    const c: Record<string, number> = { 可做: 0, 压价可做: 0, 做不了: 0, 未评估: 0 }
    rows.forEach((r) => (c[r.verdict] += 1))
    return c
  }, [rows])

  const shown = filter === 'all' ? rows : rows.filter((r) => r.verdict === filter)

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">评分对照 v2</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          原评分（AI 印象分）保持不变，这里另算一版：先按「市场 list 价 × 0.6」得到你能报的净价，再扣掉真实全成本，
          看能不能赚到 30%。毛利 40 分 + 价格空间 30 分 + 物流 10 分 + 品类 20 分，同样的数据永远算出同样的分。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={() => rescore.mutate()}
            disabled={rescore.isPending}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {rescore.isPending ? '写入中…' : '把这一版分数写入产品库'}
          </button>
          {msg && <span className="text-[11px] text-slate-500">{msg}</span>}
          {!msg && (
            <span className="text-[11px] text-slate-400">写入只新增 score_v2 等字段，原来的评分和评估内容不会被改动</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(['可做', '压价可做', '做不了', '未评估'] as Verdict2[]).map((k) => (
          <div key={k} className={cn('rounded-xl border p-3', TONE[k])}>
            <div className="text-[11px] opacity-80">{k}</div>
            <div className="text-2xl font-semibold">{counts[k] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              filter === f.key
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
            )}
          >
            {f.label}
            {f.key !== 'all' && <span className="ml-1 opacity-70">{counts[f.key] ?? 0}</span>}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-slate-400">共 {shown.length} 条 · 汇率 {fx.toFixed(3)}</span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">v2 分</th>
              <th className="px-3 py-2">判定</th>
              <th className="px-3 py-2">旧分</th>
              <th className="px-3 py-2">产品</th>
              <th className="px-3 py-2 text-right">采购价 ¥</th>
              <th className="px-3 py-2 text-right">市场 list $</th>
              <th className="px-3 py-2 text-right">毛利</th>
              <th className="px-3 py-2 text-right">上限 ¥</th>
              <th className="px-3 py-2">依据</th>
              <th className="px-3 py-2">核价</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={10} className="px-3 py-10 text-center text-slate-400">
                  加载中…
                </td>
              </tr>
            )}
            {!isLoading && shown.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-10 text-center text-slate-400">
                  没有符合条件的产品
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                <td className="px-3 py-2 font-semibold tabular-nums">{r.v2 ?? '—'}</td>
                <td className="px-3 py-2">
                  <span className={cn('rounded-full border px-2 py-0.5 text-[11px]', TONE[r.verdict])}>{r.verdict}</span>
                </td>
                <td className="px-3 py-2 text-slate-500 tabular-nums">
                  {r.oldScore ?? '—'} <span className="text-[10px] text-slate-400">{r.oldVerdict}</span>
                </td>
                <td className="max-w-[320px] px-3 py-2">
                  <div className="truncate font-medium text-slate-800" title={r.title}>
                    {r.title}
                  </div>
                  <div className="truncate text-[11px] text-slate-400" title={r.cat}>
                    {r.cat || '未分类'}
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.priceCny?.toFixed(1) ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.list?.toFixed(2) ?? '—'}</td>                <td
                  className={cn(
                    'px-3 py-2 text-right font-medium tabular-nums',
                    r.margin == null ? 'text-slate-400' : r.margin >= 0.3 ? 'text-emerald-600' : r.margin > 0 ? 'text-amber-600' : 'text-rose-600'
                  )}
                >
                  {r.margin == null ? '—' : `${(r.margin * 100).toFixed(0)}%`}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">{r.ceiling?.toFixed(1) ?? '—'}</td>
                <td className="px-3 py-2 text-[11px] text-slate-500">{r.reason}</td>
                <td className="px-3 py-2">
                  <button
                    className={cn(
                      'rounded-md border px-2 py-1 text-[11px]',
                      r.marketSource
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    )}
                    onClick={() =>
                      setPricing({
                        id: r.id,
                        title: r.title,
                        query: r.espQuery,
                        low: '',
                        high: '',
                      })
                    }
                  >
                    {r.marketSource ? `已核 ${r.marketSource}` : '核价'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs leading-relaxed text-slate-500">
        <div className="mb-1 font-semibold text-slate-700">怎么看这张表</div>
        <p>
          v2 分高且判定「可做」= 按市场价卖就有 30% 以上毛利，可以直接做。
          「压价可做」看最后一列你砍价的空间，砍得越多越不现实（超过 25% 基本等于换货源）。
          旧分只作参照，它没有把「按 list 能不能赚钱」算进去，所以大量落在 MAYBE。
        </p>
        <p className="mt-2">
          市场 list 价默认来自 AI 估价，只能算粗估。<b>点「核价」</b>会带着这个产品的英文关键词打开
          ESP 供应商站搜索同款，你把看到的 list 价区间填回来，保存后 v2 会立刻按真实市场价重算。
        </p>
      </div>

      {pricing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setPricing(null)}>
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-900">核对市场价</h3>
            <p className="mt-1 line-clamp-2 text-xs text-slate-500">{pricing.title}</p>

            <a
              href={`https://supplier.espwebsite.com/ProductResults/?SearchTerms=${encodeURIComponent(pricing.query || pricing.title)}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1 rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-100"
            >
              在 ESP 搜同款（新标签打开）↗
            </a>
            <div className="mt-1 truncate text-[11px] text-slate-400">搜索词：{pricing.query || pricing.title}</div>

            <div className="mt-4 flex items-center gap-2">
              <label className="text-xs text-slate-600">
                list 价下限 $
                <input
                  className="ml-1 w-24 rounded-md border border-slate-200 px-2 py-1 text-sm"
                  inputMode="decimal"
                  value={pricing.low}
                  onChange={(e) => setPricing({ ...pricing, low: e.target.value })}
                />
              </label>
              <label className="text-xs text-slate-600">
                上限 $
                <input
                  className="ml-1 w-24 rounded-md border border-slate-200 px-2 py-1 text-sm"
                  inputMode="decimal"
                  value={pricing.high}
                  onChange={(e) => setPricing({ ...pricing, high: e.target.value })}
                />
              </label>
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              填你看到的同类同款最低—最高价（USD）。只填一个数就上下限都填它。
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs" onClick={() => setPricing(null)}>
                取消
              </button>
              <button
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                disabled={savePrice.isPending || !pricing.low || !pricing.high}
                onClick={() => {
                  const low = Number(pricing.low)
                  const high = Number(pricing.high || pricing.low)
                  if (!Number.isFinite(low) || !Number.isFinite(high)) return
                  savePrice.mutate({ id: pricing.id, low: Math.min(low, high), high: Math.max(low, high) })
                }}
              >
                {savePrice.isPending ? '保存中…' : '保存并重算'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
