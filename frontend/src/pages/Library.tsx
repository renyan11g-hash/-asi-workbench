import { Fragment, useDeferredValue, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Archive, ChevronDown, Download, Loader2, Package, RotateCcw, Search, SearchCheck, Trash2, Wand2, X } from 'lucide-react'
import ProductThumb from '@/components/ProductThumb'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge, VerdictBadge } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import { useProducts } from '@/hooks/use-data'

const FILTERS = [
  { value: '', label: '全部' },
  { value: 'sourced', label: '待生成链接' },
  { value: 'listed', label: '已生成链接' },
  { value: 'archived', label: '已归档' },
  { value: 'trashed', label: '回收站' },
]

export default function Library() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const deferredKeyword = useDeferredValue(keyword)
  const { data: products, isLoading } = useProducts({
    q: deferredKeyword || undefined,
    status: status || undefined,
  })

  const list = products ?? []
  const isTrashTab = status === 'trashed'

  const remove = async (id: string, title: string) => {
    const msg = isTrashTab
      ? `确定永久删除「${title || '未命名商品'}」？此操作不可恢复。`
      : `确定移到回收站「${title || '未命名商品'}」？可在回收站恢复。`
    if (!window.confirm(msg)) return
    try {
      const r = await api.deleteProduct(id)
      qc.invalidateQueries({ queryKey: ['products'] })
      toast.success(isTrashTab ? '已永久删除' : r.action === 'purged' ? '已永久删除' : '已移到回收站')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const restore = async (id: string) => {
    try {
      await api.restoreProduct(id)
      qc.invalidateQueries({ queryKey: ['products'] })
      toast.success('已从回收站恢复')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const purge = async (id: string, title: string) => {
    if (!window.confirm(`永久删除「${title || '未命名商品'}」？此操作不可恢复！`)) return
    try {
      await api.purgeProduct(id)
      qc.invalidateQueries({ queryKey: ['products'] })
      toast.success('已永久删除')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const toggleArchive = async (id: string, current: string) => {
    try {
      await api.updateProduct(id, { status: current === 'archived' ? 'sourced' : 'archived' })
      qc.invalidateQueries({ queryKey: ['products'] })
      toast.success(current === 'archived' ? '已恢复' : '已归档')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            className="h-9 w-64 pl-8 text-sm"
            placeholder={isTrashTab ? '在回收站中搜索…' : '搜索中文标题或英文链接'}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatus(f.value)}
              className={`rounded-md px-3 py-1 text-xs transition-colors ${
                status === f.value
                  ? f.value === 'trashed'
                    ? 'bg-rose-600 text-white'
                    : 'bg-blue-600 text-white'
                  : f.value === 'trashed'
                    ? 'text-rose-600 hover:bg-rose-50'
                    : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            onClick={() => (window.location.href = api.exportSubmissionUrl())}
            title="导出供应商提交表格（最右 cm 列填写后，公式自动换算英寸/磅）"
          >
            <Download className="mr-1 h-4 w-4" /> 导出提交表
          </Button>
          <Button variant="outline" onClick={() => (window.location.href = api.exportCsvUrl())}>
            <Download className="mr-1 h-4 w-4" /> 导出 CSV
          </Button>
          <Button onClick={() => navigate('/sourcing')}>
            <SearchCheck className="mr-1 h-4 w-4" /> 新增选品
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {isLoading && (
          <div className="flex items-center gap-2 px-5 py-10 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        )}
        {!isLoading && list.length === 0 && (
          <div className="px-5 py-16 text-center">
            <Package className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-3 text-sm text-slate-600">
              {isTrashTab ? '回收站是空的' : '还没有商品'}
            </p>
            {!isTrashTab && (
              <Button className="mt-3" size="sm" onClick={() => navigate('/sourcing')}>
                去评估第一个 1688 商品
              </Button>
            )}
          </div>
        )}
        {list.length > 0 && (
<table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs text-slate-500">
                    <th className="px-4 py-2.5 font-medium">商品</th>
                    <th className="px-4 py-2.5 font-medium">评估</th>
                    <th className="px-4 py-2.5 font-medium">ASI 类目</th>
                    <th className="px-4 py-2.5 font-medium">箱规 / 每箱</th>
                    <th className="px-4 py-2.5 font-medium">50 件价</th>
                    <th className="px-4 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium">{isTrashTab ? '删除时间' : '更新'}</th>
                    <th className="px-4 py-2.5 text-right font-medium">操作</th>
                  </tr>
                </thead>
            <tbody>
              {list.map((p) => (
                <Fragment key={p.id}>
                <tr className={`border-b border-slate-50 hover:bg-slate-50/60 ${isTrashTab ? 'opacity-75' : ''}`}>
                  <td className="max-w-[360px] px-4 py-3">
                    <button
                      type="button"
                      className="flex w-full items-start gap-2.5 text-left"
                      onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                      title={expandedId === p.id ? '收起选品评估信息' : '展开选品评估信息'}
                    >
                      <ProductThumb images={p.source.images} size={40} clickable={false} />
                      <ChevronDown
                        className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${expandedId === p.id ? 'rotate-180' : ''}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-slate-900">
                          {p.listing?.title || p.source.sourceTitle || '(未命名)'}
                        </span>
                        {p.listing?.title && (
                          <span className="block truncate text-xs text-slate-500">{p.source.sourceTitle}</span>
                        )}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <VerdictBadge verdict={p.evaluation?.verdict} score={p.evaluation?.score} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {p.listing?.category || p.source.category || '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {p.source.cartonLCm
                      ? `${p.source.cartonLCm}×${p.source.cartonWCm}×${p.source.cartonHCm} cm`
                      : '—'}
                    {p.source.pcsPerCarton ? ` · ${p.source.pcsPerCarton} pcs` : ''}
                  </td>
                  <td className="px-4 py-3 text-xs font-medium text-slate-700">
                    {p.listing?.priceGrid?.length
                      ? `$${p.listing.priceGrid[0].unitPrice.toFixed(2)}`
                      : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {new Date(p.trashedAt || p.updatedAt).toLocaleString('zh-CN')}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {isTrashTab ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-emerald-600 hover:text-emerald-700"
                            onClick={() => restore(p.id)}
                          >
                            <RotateCcw className="mr-1 h-3 w-3" /> 恢复
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-rose-600 hover:text-rose-700"
                            onClick={() => purge(p.id, p.listing?.title || p.source.sourceTitle)}
                          >
                            <X className="mr-1 h-3 w-3" /> 永久删除
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/listing/${p.id}`)}
                          >
                            <Wand2 className="mr-1 h-3 w-3" />
                            {p.listing ? '编辑链接' : '生成链接'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleArchive(p.id, p.status)}
                          >
                            <Archive className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-rose-500 hover:text-rose-600"
                            onClick={() => remove(p.id, p.listing?.title || p.source.sourceTitle)}
                            title="移到回收站"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {expandedId === p.id && (
                  <tr className="border-b border-slate-100 bg-slate-50/70">
                    <td colSpan={8} className="px-4 py-4">
                      <div className="grid gap-3 lg:grid-cols-2">
                        <div className="rounded-lg border border-slate-200 bg-white p-3">
                          <div className="mb-2 text-xs font-semibold text-slate-700">选品资料（评估时填写）</div>
                          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs text-slate-600">
                            <span className="text-slate-400">采购价</span>
                            <span>
                              ¥{p.source.priceCny}
                              {p.source.priceMaxCny ? ` ~ ¥${p.source.priceMaxCny}` : ''}
                            </span>
                            <span className="text-slate-400">起订量 MOQ</span>
                            <span>{p.source.moq || '—'}</span>
                            <span className="text-slate-400">供应商</span>
                            <span className="truncate">{p.source.supplier || '—'}</span>
                            <span className="text-slate-400">材质</span>
                            <span>{p.source.materialCn || '—'}</span>
                            <span className="text-slate-400">颜色</span>
                            <span>{p.source.colorsCn || '—'}</span>
                            <span className="text-slate-400">尺寸 / 规格</span>
                            <span>{p.source.sizeCn || '—'}</span>
                            <span className="text-slate-400">单件重量</span>
                            <span>{p.source.weightG ? `${p.source.weightG} g` : '—'}</span>
                            <span className="text-slate-400">1688 链接</span>
                            <span className="truncate">
                              {p.source.sourceUrl ? (
                                <a href={p.source.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                                  打开商品页
                                </a>
                              ) : (
                                '—'
                              )}
                            </span>
                            {p.source.notes && (
                              <>
                                <span className="text-slate-400">备注</span>
                                <span>{p.source.notes}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-white p-3">
                          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
                            AI 评估结论
                            <VerdictBadge verdict={p.evaluation?.verdict} score={p.evaluation?.score} />
                          </div>
                          {p.evaluation ? (
                            <div className="space-y-2 text-xs text-slate-600">
                              <p className="leading-relaxed">{p.evaluation.summary}</p>
                              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                                <span className="text-slate-400">建议售价</span>
                                <span className="font-medium text-slate-700">
                                  {p.evaluation.priceAdviceUsd
                                    ? `$${p.evaluation.priceAdviceUsd.min} ~ $${p.evaluation.priceAdviceUsd.max}`
                                    : '—'}
                                </span>
                                <span className="text-slate-400">ASI 类目</span>
                                <span>
                                  {p.evaluation.asiCategories?.length
                                    ? p.evaluation.asiCategories.join('、')
                                    : '—'}
                                </span>
                              </div>
                              {(p.evaluation.buyers?.length ?? 0) > 0 && (
                                <p>
                                  <span className="text-slate-400">卖给谁：</span>
                                  {p.evaluation.buyers.join('、')}
                                </p>
                              )}
                              {(p.evaluation.occasions?.length ?? 0) > 0 && (
                                <p>
                                  <span className="text-slate-400">适用场合：</span>
                                  {p.evaluation.occasions.join('、')}
                                </p>
                              )}
                              {p.evaluation.sourcingTips && (
                                <p>
                                  <span className="text-slate-400">采购要点：</span>
                                  {p.evaluation.sourcingTips}
                                </p>
                              )}
                              {(p.evaluation.listingHooks?.length ?? 0) > 0 && (
                                <div>
                                  <span className="text-slate-400">上架思路：</span>
                                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                                    {p.evaluation.listingHooks.map((h, i) => (
                                      <li key={i}>{h}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-xs text-slate-400">暂无 AI 评估结论</p>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-slate-400">
        {isTrashTab
          ? `共 ${list.length} 条在回收站。可单独「恢复」或「永久删除」，或在「设置 → 清空产品库」一键清空回收站。`
          : '共 ' + list.length + ' 条。导出的 CSV 含标题、描述、关键词、颜色材质、印花方式与各档价格，可直接用于上架或发给客户报价。'}
      </p>
    </div>
  )
}
