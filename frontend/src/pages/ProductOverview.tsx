import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Search, Package, Sparkles, MessageCircle, Copy, Loader2, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import ProductThumb from '@/components/ProductThumb'
import { api } from '@/lib/api'
import type { Product, SupplierCommunication } from '@/types'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

function money(value?: number | null) {
  return value == null || !Number.isFinite(value) ? '待补充' : `¥${value.toFixed(2)}`
}

export default function ProductOverview() {
  const [keyword, setKeyword] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [question, setQuestion] = useState('')
  const [replying, setReplying] = useState(false)
  const [platformName, setPlatformName] = useState('')
  const [platformProductId, setPlatformProductId] = useState('')
  const [platformUrl, setPlatformUrl] = useState('')
  const [savingPlatform, setSavingPlatform] = useState(false)
  const queryClient = useQueryClient()

  const { data: products = [], isLoading } = useQuery({
    queryKey: ['products', 'overview'],
    queryFn: () => api.listProducts({}),
  })
  const { data: communications = [] } = useQuery({
    queryKey: ['supplier-communications', 'overview'],
    queryFn: () => api.listCommunications(),
  })

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    if (!q) return products
    return products.filter((p) => [
      p.code, p.source.sourceTitle, p.listing?.title, p.source.supplier,
      p.source.sourceUrl, p.source.category, ...(p.source.sourceKeywords ?? []),
    ].some((v) => String(v ?? '').toLowerCase().includes(q)))
  }, [products, keyword])

  const selected = filtered.find((p) => p.id === selectedId) ?? products.find((p) => p.id === selectedId) ?? filtered[0] ?? null
  const selectedComms = selected ? communications.filter((c) => c.productId === selected.id) : []

  useEffect(() => {
    setPlatformName(selected?.platformName ?? '')
    setPlatformProductId(selected?.platformProductId ?? '')
    setPlatformUrl(selected?.platformUrl ?? '')
  }, [selected?.id, selected?.platformName, selected?.platformProductId, selected?.platformUrl])

  const savePlatformInfo = async () => {
    if (!selected || savingPlatform) return
    if (platformUrl.trim() && !/^https?:\\/\\//i.test(platformUrl.trim())) {
      toast.error('平台链接需要以 http:// 或 https:// 开头')
      return
    }
    setSavingPlatform(true)
    try {
      await api.updateProduct(selected.id, {
        platformName: platformName.trim(),
        platformProductId: platformProductId.trim(),
        platformUrl: platformUrl.trim(),
      })
      await queryClient.invalidateQueries({ queryKey: ['products', 'overview'] })
      toast.success('平台商品信息已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSavingPlatform(false)
    }
  }

  const askAssistant = async () => {
    if (!selected || !question.trim() || replying) return
    const next = [...messages, { role: 'user' as const, content: question.trim() }]
    setMessages(next)
    setQuestion('')
    setReplying(true)
    try {
      const result = await api.assistantChat({
        source: selected.source,
        listing: selected.listing,
        messages: next,
      })
      setMessages([...next, { role: 'assistant', content: result.reply || '暂时没有生成回复。' }])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'AI 助手暂时不可用')
    } finally {
      setReplying(false)
    }
  }

  const copyText = async (value: string) => {
    if (!value) return
    await navigator.clipboard.writeText(value)
    toast.success('已复制')
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[260px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} className="pl-9" placeholder="搜索 GLS 编号、产品名称、供应商、关键词…" />
        </div>
        <div className="text-sm text-slate-500">共 {filtered.length} 个产品</div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.9fr)]">
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3 font-medium">产品列表</div>
          {isLoading ? (
            <div className="flex items-center gap-2 p-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />正在加载产品…</div>
          ) : filtered.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500"><Package className="mx-auto mb-2 h-8 w-8 text-slate-300" />没有找到匹配的产品</div>
          ) : (
            <div className="max-h-[76vh] overflow-auto divide-y divide-slate-100">
              {filtered.map((p) => (
                <button key={p.id} onClick={() => { setSelectedId(p.id); setMessages([]) }} className={`flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50 ${selected?.id === p.id ? 'bg-blue-50/70' : ''}`}>
                  <ProductThumb images={p.source.images} size={54} clickable={false} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-blue-700">{p.code || '未分配编号'}</span>
                      <span className="truncate text-sm font-medium text-slate-900">{p.listing?.title || p.source.sourceTitle || '未命名产品'}</span>
                    </span>
                    <span className="mt-1 block truncate text-xs text-slate-500">{p.source.supplier || '供应商待补充'} · {p.source.category || '未分类'}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                </button>
              ))}
            </div>
          )}
        </section>

        <div className="space-y-4">
          {selected ? (
            <>
              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-start gap-3">
                  <ProductThumb images={selected.source.images} size={88} clickable />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs text-blue-700">{selected.code || '未分配 GLS'}</div>
                    <h2 className="mt-1 text-base font-semibold">{selected.listing?.title || selected.source.sourceTitle || '未命名产品'}</h2>
                    <p className="mt-1 text-xs text-slate-500">{selected.source.sourceTitle}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selected.source.sourceUrl && <Button size="sm" variant="outline" onClick={() => window.open(selected.source.sourceUrl, '_blank', 'noopener,noreferrer')}><ExternalLink className="mr-1 h-3.5 w-3.5" />1688 来源</Button>}
                      {selected.platformUrl && <Button size="sm" variant="outline" onClick={() => window.open(selected.platformUrl, '_blank', 'noopener,noreferrer')}><ExternalLink className="mr-1 h-3.5 w-3.5" />平台商品</Button>}
                      <Button size="sm" variant="outline" onClick={() => copyText(selected.code || '')}><Copy className="mr-1 h-3.5 w-3.5" />复制 GLS</Button>
                      <Button size="sm" onClick={() => window.location.href = `/listing/${selected.id}`}>打开产品档案</Button>
                    </div>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <Info label="供应商" value={selected.source.supplier} />
                  <Info label="采购价" value={money(selected.source.priceCny)} />
                  <Info label="起订量" value={selected.source.moq ? `${selected.source.moq} pcs` : '待补充'} />
                  <Info label="材质" value={selected.source.materialCn} />
                  <Info label="颜色" value={selected.source.colorsCn} />
                  <Info label="尺寸" value={selected.source.sizeCn} />
                  <Info label="重量" value={selected.source.weightG != null ? `${selected.source.weightG} g` : '待补充'} />
                  <Info label="每箱数量" value={selected.source.pcsPerCarton ? `${selected.source.pcsPerCarton} pcs` : '待补充'} />
                </div>
                <div className="mt-4 space-y-3 rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">平台商品信息</h3>{selected.platformUrl && <a href={selected.platformUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"><ExternalLink className="h-3 w-3" />打开平台链接</a>}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1 text-xs text-slate-500">平台名称<Input value={platformName} onChange={(e) => setPlatformName(e.target.value)} placeholder="例如 Ripple" /></label>
                    <label className="space-y-1 text-xs text-slate-500">平台商品编号<Input value={platformProductId} onChange={(e) => setPlatformProductId(e.target.value)} placeholder="平台上的商品编号" /></label>
                  </div>
                  <label className="block space-y-1 text-xs text-slate-500">平台商品链接<Input value={platformUrl} onChange={(e) => setPlatformUrl(e.target.value)} placeholder="https://…" /></label>
                  <div className="flex items-center justify-between gap-2"><span className="text-xs text-slate-500">空字段会保留为空，不会用 1688 链接代替。</span><Button size="sm" onClick={() => void savePlatformInfo()} disabled={savingPlatform}>{savingPlatform ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}保存平台信息</Button></div>
                </div>
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-medium">供应商沟通与报价</h3>
                  <span className="text-xs text-slate-500">{selectedComms.length} 条记录</span>
                </div>
                {selectedComms.length ? (
                  <div className="space-y-3">
                    {selectedComms.slice(0, 5).map((c: SupplierCommunication) => (
                      <div key={c.id} className="rounded-lg border border-slate-100 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="font-medium">{c.supplierName}</span>
                          <span className="text-xs text-slate-500">{new Date(c.createdAt).toLocaleDateString()}</span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{c.response || c.content}</p>
                        <div className="mt-2 flex gap-3 text-xs text-slate-500">
                          <span>报价：{money(c.priceCny)}</span><span>MOQ：{c.moq ?? '待补充'}</span><span>交期：{c.leadTime || '待补充'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-sm text-slate-500">暂无供应商沟通记录；当前主供应商名称和采购信息见上方产品资料。</p>}
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-3 flex items-center gap-2 font-medium"><Sparkles className="h-4 w-4 text-violet-600" />产品 AI 助手</div>
                <div className="max-h-56 space-y-2 overflow-auto rounded-lg bg-slate-50 p-3">
                  {messages.length === 0 && <p className="text-xs text-slate-500">围绕当前产品提问，例如：帮我整理客户报价前需要确认的参数，或总结供应商资料缺口。</p>}
                  {messages.map((m, i) => <div key={i} className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${m.role === 'user' ? 'ml-8 bg-blue-100 text-blue-950' : 'mr-5 bg-white text-slate-700'}`}>{m.content}</div>)}
                </div>
                <div className="mt-3 flex gap-2">
                  <Input value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void askAssistant() } }} placeholder="输入关于该产品的问题…" />
                  <Button onClick={() => void askAssistant()} disabled={!question.trim() || replying}>{replying ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}</Button>
                </div>
              </section>
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">选择左侧产品查看详细资料</div>
          )}
        </div>
      </div>
    </div>
  )
}

function Info({ label, value }: { label: string; value?: string | number | null }) {
  return <div className="min-w-0"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 break-words text-sm font-medium text-slate-800">{value || '待补充'}</div></div>
}
