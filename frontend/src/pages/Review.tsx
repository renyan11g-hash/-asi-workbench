import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Clock, MessageSquare, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { Product } from '@/types'
import { cn } from '@/lib/utils'
import ProductThumb from '@/components/ProductThumb'

/**
 * 审核队列
 *
 * 目的：把「我到底要不要做这个品」的判断变成数据。
 * - 默认只看待审（未审核 = pending），按 v2 分从高到低排
 * - 三个动作：通过 / 待询价（要先问 1688 商家箱规尺寸）/ 否决（必须选理由）
 * - 支持多选批量操作
 * 不改原来的 evaluation，只写 review_state / reject_reasons / review_note。
 */

type State = 'pending' | 'approved' | 'parked' | 'rejected'

const STATE_LABEL: Record<State, string> = {
  pending: '待审',
  approved: '通过',
  parked: '待询价',
  rejected: '否决',
}

const STATE_TONE: Record<State, string> = {
  pending: 'bg-slate-100 text-slate-600 border-slate-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  parked: 'bg-sky-50 text-sky-700 border-sky-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
}

const REJECT_REASONS = ['不满意商家', '定制太复杂', '价格太贵（有更合适的）', '体积重·运费太高', '同款太多没差异', '质量存疑', '产品本身不适合', '其他']

const FILTERS: Array<{ key: State | 'all'; label: string }> = [
  { key: 'pending', label: '待审' },
  { key: 'approved', label: '通过' },
  { key: 'parked', label: '待询价' },
  { key: 'rejected', label: '否决' },
  { key: 'all', label: '全部' },
]

const stateOf = (p: Product): State => (p.reviewState as State) || 'pending'

export default function Review() {
  const qc = useQueryClient()
  const [scope, setScope] = useState<'auto' | 'manual' | 'all'>('auto')
  const [filter, setFilter] = useState<State | 'all'>('pending')
  const [selected, setSelected] = useState<string[]>([])
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [pickedReasons, setPickedReasons] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState('')

  const { data: products, isLoading } = useQuery({ queryKey: ['products', 'all'], queryFn: () => api.listProducts() })

  const rows = useMemo(() => {
    const all = [...(products ?? [])]
    const scoped = scope === 'all' ? all : all.filter((p) => (p.origin ?? 'manual') === scope)
    scoped.sort((a, b) => (b.scoreV2 ?? -1) - (a.scoreV2 ?? -1))
    return scoped
  }, [products, scope])

  const counts = useMemo(() => {
    const c: Record<string, number> = { pending: 0, approved: 0, parked: 0, rejected: 0 }
    rows.forEach((p) => (c[stateOf(p)] += 1))
    return c
  }, [rows])

  const shown = filter === 'all' ? rows : rows.filter((p) => stateOf(p) === filter)

  const review = useMutation({
    mutationFn: (args: { ids: string[]; state: State; reasons?: string[]; note?: string }) =>
      args.ids.length === 1
        ? api.reviewProduct(args.ids[0], { state: args.state, reasons: args.reasons, note: args.note }).then(() => ({ updated: 1 }))
        : api.reviewBulk(args.ids, { state: args.state, reasons: args.reasons, note: args.note }),
    onSuccess: (r, args) => {
      setMsg(`已${STATE_LABEL[args.state]} ${r.updated} 条`)
      setSelected([])
      setRejectingId(null)
      setPickedReasons([])
      setNote('')
      qc.invalidateQueries({ queryKey: ['products'] })
    },
    onError: () => setMsg('操作失败，请重试'),
  })

  const act = (ids: string[], state: State, reasons?: string[], text?: string) => {
    if (!ids.length) return
    review.mutate({ ids, state, reasons, note: text })
  }

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const allShownSelected = shown.length > 0 && shown.every((p) => selected.includes(p.id))

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">审核队列</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          按 v2 分从高到低审。通过 = 可以开始做 listing；待询价 = 先问 1688 商家箱规/尺寸/打样再定；否决要选理由，
          方便以后回看为什么没做。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-400">范围</span>
          {(
            [
              { k: 'auto', label: '自动选品' },
              { k: 'manual', label: '我手动录的' },
              { k: 'all', label: '全部' },
            ] as const
          ).map((s) => (
            <button
              key={s.k}
              onClick={() => setScope(s.k)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11px]',
                scope === s.k
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        {msg && <div className="mt-2 text-xs text-emerald-600">{msg}</div>}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(['pending', 'approved', 'parked', 'rejected'] as State[]).map((k) => (
          <div key={k} className={cn('rounded-xl border p-3', STATE_TONE[k])}>
            <div className="text-[11px] opacity-80">{STATE_LABEL[k]}</div>
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
        <span className="ml-auto text-[11px] text-slate-400">共 {shown.length} 条</span>
      </div>

      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-900/10 bg-slate-900 px-4 py-2.5 text-xs text-white">
          <span className="font-medium">已选 {selected.length} 条</span>
          <button className="ml-2 rounded-md bg-emerald-500 px-2.5 py-1 font-medium" onClick={() => act(selected, 'approved')}>
            批量通过
          </button>
          <button className="rounded-md bg-sky-500 px-2.5 py-1 font-medium" onClick={() => act(selected, 'parked')}>
            批量待询价
          </button>
          <button
            className="rounded-md bg-rose-500 px-2.5 py-1 font-medium"
            onClick={() => {
              setRejectingId('BULK')
              setPickedReasons([])
            }}
          >
            批量否决
          </button>
          <button className="ml-auto text-white/70 hover:text-white" onClick={() => setSelected([])}>
            取消选择
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[1000px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allShownSelected}
                  onChange={(e) => setSelected(e.target.checked ? shown.map((p) => p.id) : [])}
                />
              </th>
              <th className="px-3 py-2">产品</th>
              <th className="px-3 py-2">v2</th>
              <th className="px-3 py-2 text-right">毛利</th>
              <th className="px-3 py-2 text-right">采购价上限</th>
              <th className="px-3 py-2">状态</th>
              <th className="px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-slate-400">
                  加载中…
                </td>
              </tr>
            )}
            {!isLoading && shown.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-slate-400">
                  {scope === 'auto'
                    ? '还没有自动选品的候选。去「自动选品」页跑一次，或等每天 08:00 的定时任务。'
                    : '这个分类下没有产品'}
                </td>
              </tr>
            )}
            {shown.map((p) => {
              const st = stateOf(p)
              return (
                <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} />
                  </td>
                  <td className="max-w-[380px] px-3 py-2">
                    <div className="flex items-start gap-2">
                      <ProductThumb images={p.source.images} size={36} clickable={false} />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-800" title={p.listing?.titleZh || p.source.sourceTitle}>
                          {p.listing?.titleZh || p.source.sourceTitle || '(未命名)'}
                        </div>
                        <div className="truncate text-[11px] text-slate-400">
                          ¥{p.source.priceCny ?? '—'} · {(p.evaluation?.asiCategories ?? []).slice(0, 2).join(' / ') || '未分类'}
                        </div>
                        {p.selectionReason && (
                          <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-sky-600" title={p.selectionReason}>
                            {p.selectionReason}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[11px]',
                        p.verdictV2 === 'GO'
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : p.verdictV2 === 'NEGOTIATE'
                            ? 'border-amber-200 bg-amber-50 text-amber-700'
                            : p.verdictV2 === 'NO'
                              ? 'border-rose-200 bg-rose-50 text-rose-700'
                              : 'border-slate-200 bg-slate-50 text-slate-500'
                      )}
                    >
                      {p.scoreV2 ?? '—'}
                    </span>
                  </td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', p.marginV2 != null && p.marginV2 < 0 ? 'text-rose-600' : 'text-slate-700')}>
                    {p.marginV2 != null ? `${(p.marginV2 * 100).toFixed(0)}%` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                    {p.ceilingCny != null ? `¥${p.ceilingCny.toFixed(1)}` : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn('rounded-full border px-2 py-0.5 text-[11px]', STATE_TONE[st])}>{STATE_LABEL[st]}</span>
                    {p.rejectReasons && p.rejectReasons.length > 0 && (
                      <div className="mt-1 text-[10px] text-slate-400">{p.rejectReasons.join('、')}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        title="通过"
                        className="rounded-md border border-emerald-200 bg-emerald-50 p-1.5 text-emerald-700 hover:bg-emerald-100"
                        onClick={() => act([p.id], 'approved')}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title="待询价"
                        className="rounded-md border border-sky-200 bg-sky-50 p-1.5 text-sky-700 hover:bg-sky-100"
                        onClick={() => act([p.id], 'parked')}
                      >
                        <Clock className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title="否决"
                        className="rounded-md border border-rose-200 bg-rose-50 p-1.5 text-rose-700 hover:bg-rose-100"
                        onClick={() => {
                          setRejectingId(p.id)
                          setPickedReasons([])
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                      {st !== 'pending' && (
                        <button
                          title="退回待审"
                          className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-50"
                          onClick={() => act([p.id], 'pending')}
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {rejectingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setRejectingId(null)}>
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-900">
              否决 {rejectingId === 'BULK' ? `${selected.length} 条` : '这 1 条'} —— 至少选一个理由
            </h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {REJECT_REASONS.map((r) => (
                <button
                  key={r}
                  onClick={() =>
                    setPickedReasons((s) => (s.includes(r) ? s.filter((x) => x !== r) : [...s, r]))
                  }
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs',
                    pickedReasons.includes(r)
                      ? 'border-rose-300 bg-rose-50 text-rose-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
            <textarea
              className="mt-3 w-full rounded-lg border border-slate-200 p-2 text-xs"
              rows={3}
              placeholder="补充说明（可留空）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs" onClick={() => setRejectingId(null)}>
                取消
              </button>
              <button
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                disabled={pickedReasons.length === 0}
                onClick={() => act(rejectingId === 'BULK' ? selected : [rejectingId], 'rejected', pickedReasons, note)}
              >
                确认否决
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
