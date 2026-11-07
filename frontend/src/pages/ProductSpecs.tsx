import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileEdit,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { ProductSpecDetail, ProductSpecs } from '@/types'

/**
 * 产品资料卡（批量生产系统 V1 · 第一阶段）。
 *
 * 每个产品一张卡（不管是单条录入还是批量录入的），卡片上直接看 14 个字段填了几个、
 * 哪些还是 Unknown。点开右侧抽屉能看原始资料对照、能改、能单条重新提取。
 *
 * 结构化结果单独存，原始资料一个字节都不动 —— 所以在这里改错了也不会影响 1688 原文。
 */
export default function ProductSpecsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [filter, setFilter] = useState<'all' | 'done' | 'missing' | 'none'>('all')
  const [selected, setSelected] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const cardsQuery = useQuery({
    queryKey: ['product-spec-cards', q, category, filter],
    queryFn: () => api.listProductSpecCards({ q: q || undefined, category: category || undefined, filter }),
  })

  const cards = cardsQuery.data?.cards ?? []
  const fields = cardsQuery.data?.fields ?? []
  const counts = cardsQuery.data?.counts

  const selectedCards = useMemo(() => cards.filter((c) => selected.includes(c.productId)), [cards, selected])

  const extractBatch = async () => {
    if (!selected.length) return
    if (!window.confirm(`用 AI 提取选中的 ${selected.length} 个产品的结构化资料？\n\n会排队逐条跑，可以随时暂停/取消；原始资料不会被改动。`)) return
    setBusy(true)
    try {
      const { job, skipped } = await api.createProductionJob({
        kind: 'spec',
        productIds: selected,
        clientKey: `spec-${Date.now()}`,
      })
      localStorage.setItem('asi-production:jobId', job.id)
      qc.invalidateQueries({ queryKey: ['product-spec-cards'] })
      if (skipped.length) toast.warning(`已提交 ${job.items.length} 条，跳过 ${skipped.length} 条：${skipped[0].reason}`)
      else toast.success(`已开始提取 ${job.items.length} 个产品的资料`)
      navigate('/production')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { key: 'all', label: '全部产品', value: counts?.all ?? 0, tone: 'text-slate-700' },
          { key: 'done', label: '资料完整', value: counts?.done ?? 0, tone: 'text-emerald-600' },
          { key: 'missing', label: '有 Unknown', value: counts?.missing ?? 0, tone: 'text-amber-600' },
          { key: 'none', label: '从未提取', value: counts?.none ?? 0, tone: 'text-slate-500' },
        ].map((c) => (
          <button
            key={c.key}
            onClick={() => setFilter(c.key as typeof filter)}
            className={cn(
              'rounded-xl border bg-white p-4 text-left shadow-sm transition-colors hover:border-blue-300',
              filter === c.key ? 'border-blue-400 ring-1 ring-blue-200' : 'border-slate-200'
            )}
          >
            <div className="text-xs font-medium text-slate-500">{c.label}</div>
            <div className={cn('mt-1 text-2xl font-bold tracking-tight', c.tone)}>{c.value}</div>
          </button>
        ))}
      </div>

      <SectionCard
        title="产品信息卡"
        hint="14 个标准字段。AI 只从现有资料里提取，资料里没有的一律标 Unknown，不会编。"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ['product-spec-cards'] })}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
            </Button>
            <Button size="sm" disabled={busy || selected.length === 0} onClick={() => void extractBatch()}>
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
              批量提取资料{selected.length ? `（${selected.length}）` : ''}
            </Button>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜编号 / 产品名"
              className="h-9 w-64 rounded-md border border-slate-200 pl-8 pr-2 text-sm outline-none focus:border-blue-400"
            />
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-9 rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-blue-400"
          >
            <option value="">全部类别</option>
            {(cardsQuery.data?.categories ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {(['all', 'done', 'missing', 'none'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs',
                filter === f
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              )}
            >
              {{ all: '全部', done: '资料完整', missing: '有 Unknown', none: '未提取' }[f]}
            </button>
          ))}
          <span className="ml-auto text-xs text-slate-400">
            共 {cards.length} 条{selected.length ? `，已选 ${selected.length}` : ''}
          </span>
          {cards.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-slate-500"
              onClick={() => setSelected(selected.length === cards.length ? [] : cards.map((c) => c.productId))}
            >
              {selected.length === cards.length ? '取消全选' : '全选本页'}
            </Button>
          )}
        </div>

        {cardsQuery.isLoading ? (
          <div className="flex items-center justify-center py-16 text-sm text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载产品信息卡…
          </div>
        ) : cards.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-14 text-center">
            <Database className="mx-auto mb-2 h-6 w-6 text-slate-300" />
            <p className="text-sm font-medium text-slate-600">还没有产品</p>
            <p className="mt-1 text-xs text-slate-400">先去「产品信息预填」录入，或到「批量处理」导入一批 1688 链接</p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((c) => {
              const thumb = c.thumb || c.thumbFallback
              const pct = Math.round((c.specs.filled / c.specs.total) * 100)
              const checked = selected.includes(c.productId)
              return (
                <div
                  key={c.productId}
                  className={cn(
                    'rounded-xl border bg-white p-3 transition-colors',
                    checked ? 'border-blue-400 ring-1 ring-blue-200' : 'border-slate-200 hover:border-slate-300'
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <input
                      type="checkbox"
                      className="mt-1 h-3.5 w-3.5"
                      checked={checked}
                      onChange={() =>
                        setSelected((cur) =>
                          cur.includes(c.productId) ? cur.filter((x) => x !== c.productId) : [...cur, c.productId]
                        )
                      }
                    />
                    {thumb ? (
                      <img src={thumb} alt="" className="h-12 w-12 shrink-0 rounded border border-slate-200 object-cover" />
                    ) : (
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50">
                        <Database className="h-4 w-4 text-slate-300" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-white">
                          {c.code || '—'}
                        </span>
                        {c.specs.stale && (
                          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-700">
                            资料已变
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 line-clamp-2 text-[13px] font-medium text-slate-800">
                        {c.title || '(未命名产品)'}
                      </div>
                      {c.category && <div className="mt-0.5 truncate text-[11px] text-slate-400">{c.category}</div>}
                    </div>
                  </div>

                  <div className="mt-2.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-500">
                        资料 {c.specs.filled}/{c.specs.total}
                      </span>
                      <span className={pct === 100 ? 'text-emerald-600' : 'text-amber-600'}>{pct}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={cn('h-full rounded-full', pct === 100 ? 'bg-emerald-500' : 'bg-amber-400')}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {c.specs.unknownFields.slice(0, 4).map((k) => (
                      <span
                        key={k}
                        className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
                      >
                        {fields.find((f) => f.key === k)?.label ?? k} Unknown
                      </span>
                    ))}
                    {c.specs.unknownFields.length > 4 && (
                      <span className="text-[10px] text-slate-400">+{c.specs.unknownFields.length - 4}</span>
                    )}
                    {c.specs.filled === c.specs.total && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600">
                        <CheckCircle2 className="h-3 w-3" /> 齐全
                      </span>
                    )}
                  </div>

                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-[10px] text-slate-400">
                      {c.specs.editedAt ? '人工改过' : c.specs.extractedAt ? 'AI 提取' : '还没提取'}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setOpenId(c.productId)}
                      >
                        <FileEdit className="mr-1 h-3 w-3" /> 查看/编辑
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>

      {openId && (
        <SpecDrawer
          productId={openId}
          fields={fields}
          onClose={() => setOpenId(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['product-spec-cards'] })}
        />
      )}

      {selectedCards.length > 0 && (
        <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-4 py-3 text-[12px] leading-relaxed text-slate-600">
          <span className="font-medium text-slate-800">已选 {selectedCards.length} 个产品。</span>
          批量提取会排队逐条跑（每个约 10~20 秒），可以到「批量生产中心」看进度、暂停或取消。
          结构化资料之后会自动作为英文 Listing 生成的事实来源。
        </div>
      )}
    </div>
  )
}

/** 右侧抽屉：原始资料对照 + 14 字段编辑 + 单条重新提取 */
function SpecDrawer({
  productId,
  fields,
  onClose,
  onSaved,
}: {
  productId: string
  fields: Array<{ key: keyof ProductSpecs; label: string; hint: string }>
  onClose: () => void
  onSaved: () => void
}) {
  const detailQuery = useQuery({
    queryKey: ['product-spec-detail', productId],
    queryFn: () => api.getProductSpec(productId),
  })
  const [draft, setDraft] = useState<ProductSpecs | null>(null)
  const [saving, setSaving] = useState(false)
  const [extracting, setExtracting] = useState(false)

  const detail = detailQuery.data as ProductSpecDetail | undefined

  useEffect(() => {
    if (detail) setDraft({ ...detail.record.specs })
  }, [detail])

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      await api.saveProductSpec(productId, draft)
      toast.success('已保存（之后生成 Listing 以这份资料为准）')
      onSaved()
      void detailQuery.refetch()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const extract = async (keepManual: boolean) => {
    if (!keepManual && !window.confirm('重新提取会把人工改过的字段也一起覆盖，确定？')) return
    setExtracting(true)
    try {
      const r = await api.extractProductSpec(productId, keepManual)
      setDraft({ ...r.record.specs })
      toast.success(`提取完成：已填 ${r.record.filled}/${r.record.total} 项，其余标 Unknown`)
      onSaved()
      void detailQuery.refetch()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setExtracting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-3xl flex-col overflow-hidden bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-100 px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[11px] text-white">
                {detail?.code || '—'}
              </span>
              <span className="truncate text-sm font-semibold text-slate-900">
                {detail?.title || '加载中…'}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-500">
              结构化资料只保存整理结果，原始 1688 资料不会被改动
              {detail?.stale ? '；⚠ 原始资料改过了，建议重新提取' : ''}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {detailQuery.isLoading || !draft ? (
            <div className="flex items-center justify-center py-20 text-sm text-slate-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载…
            </div>
          ) : (
            <div className="space-y-4">
              {detail && (
                <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px]">
                  <summary className="cursor-pointer font-medium text-slate-700">查看原始 1688 资料（对照用）</summary>
                  <div className="mt-2 space-y-1 text-slate-600">
                    <div>标题：{detail.source.title || '—'}</div>
                    <div>材质：{detail.source.materialCn || '—'}</div>
                    <div>颜色：{detail.source.colorsCn || '—'}</div>
                    <div>尺寸：{detail.source.sizeCn || '—'}</div>
                    <div>
                      箱规：
                      {detail.source.carton.filter(Boolean).length
                        ? `${detail.source.carton.map((v) => v ?? '?').join(' x ')} cm / ${detail.source.pcsPerCarton ?? '?'} pcs / ${detail.source.cartonGwKg ?? '?'} kg`
                        : '—'}
                    </div>
                    <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
                      详情：{detail.source.description || '—'}
                    </div>
                  </div>
                </details>
              )}

              <div className="grid gap-3 md:grid-cols-2">
                {(fields.length ? fields : detail?.fields ?? []).map((f) => {
                  const value = draft[f.key] ?? ''
                  const unknown = !value || value === 'Unknown'
                  return (
                    <label key={f.key} className="block">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[12px] font-medium text-slate-700">{f.label}</span>
                        {unknown && (
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">Unknown</span>
                        )}
                      </div>
                      <textarea
                        value={value === 'Unknown' ? '' : value}
                        onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                        rows={2}
                        maxLength={500}
                        placeholder={unknown ? '资料里没有这项，可留空或手工补' : ''}
                        className={cn(
                          'w-full resize-y rounded-md border px-2 py-1.5 text-[12px] outline-none focus:border-blue-400',
                          unknown ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200'
                        )}
                      />
                      <div className="mt-0.5 text-[10px] text-slate-400">{f.hint}</div>
                    </label>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3">
          <Button size="sm" onClick={() => void save()} disabled={saving || !draft}>
            {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
            保存修改
          </Button>
          <Button size="sm" variant="outline" disabled={extracting} onClick={() => void extract(true)}>
            {extracting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}
            AI 重新提取（保留我填的）
          </Button>
          <Button size="sm" variant="ghost" disabled={extracting} onClick={() => void extract(false)}>
            全部重新提取
          </Button>
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-400">
            <AlertTriangle className="h-3 w-3" /> 留空 = Unknown，不会编造
          </span>
        </div>
      </div>
    </div>
  )
}
