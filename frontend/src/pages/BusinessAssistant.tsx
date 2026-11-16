import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Bot, Send, Loader2, Package, Users, MessageSquare, ClipboardList, FileText, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { orderApi, businessOpsApi } from '@/lib/api'
import { useNavigate } from 'react-router-dom'

type Entity = { type: 'product'|'customer'|'inquiry'|'order'|'quote'; id: string; customerId?: string }
type Message = { role: 'user' | 'assistant'; content: string; entities?: Entity[]; missingInfo?: string[] }
const suggestions = [
  '帮我查一下最近有哪些新询盘，分别来自哪些客户？',
  '查找 GLS 编号对应的产品、平台链接和供应商资料',
  '某个客户之前询过哪些产品、收到过哪些报价？',
  '目前有哪些订单未付款或还在生产/运输？',
  '整理某个产品的供应商历史报价和交期记录',
]
const entityLabels: Record<string,string> = { product: '产品', customer: '客户', inquiry: '询盘', order: '订单', quote: '报价' }

export default function BusinessAssistant() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const navigate = useNavigate()
  const emailDraftMutation = useMutation({
    mutationFn: (entity: Entity) => {
      if (!entity.customerId) throw new Error('该询盘缺少客户关联，无法生成邮件草稿')
      return orderApi.generateEmailDraft({ customerId: entity.customerId, inquiryId: entity.id, tone: 'professional' })
    },
    onSuccess: () => {
      toast.success('邮件草稿已生成并保存，可在「邮件草稿」中编辑确认；不会自动发送')
      navigate('/order-center?tab=emails')
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '邮件草稿生成失败'),
  })
  const mutation = useMutation({
    mutationFn: (next: Message[]) => businessOpsApi.assistant({ messages: next.map(({role,content}) => ({role,content})) }),
    onSuccess: (result, next) => setMessages([...next, { role: 'assistant', content: result.reply, entities: result.entities, missingInfo: result.missingInfo }]),
    onError: (error) => toast.error(error instanceof Error ? error.message : 'AI 助手暂时不可用'),
  })
  const send = (text = input) => {
    const content = text.trim()
    if (!content || mutation.isPending) return
    const next = [...messages, { role: 'user' as const, content }]
    setMessages(next)
    setInput('')
    mutation.mutate(next)
  }
  const reset = () => { setMessages([]); setInput('') }
  const openEntity = (entity: Entity) => {
    if (entity.type === 'product') navigate(`/listing/${entity.id}`)
    else if (entity.type === 'customer') navigate('/order-center?tab=customers')
    else if (entity.type === 'inquiry' || entity.type === 'quote') navigate('/order-center?tab=inquiries')
    else navigate('/order-center?tab=orders')
  }
  const EntityIcon = ({type}:{type:string}) => type === 'product' ? <Package className="h-3.5 w-3.5"/> : type === 'customer' ? <Users className="h-3.5 w-3.5"/> : type === 'inquiry' ? <MessageSquare className="h-3.5 w-3.5"/> : type === 'order' ? <ClipboardList className="h-3.5 w-3.5"/> : <FileText className="h-3.5 w-3.5"/>
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <section className="rounded-xl border bg-white p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-700"><Bot className="h-5 w-5"/></div>
          <div><h2 className="font-semibold">Workbench AI 业务助手</h2><p className="text-xs text-slate-500">直接查询现有业务资料，回答会附带可定位的记录。只读分析，不会擅自修改数据或发送邮件。</p></div>
          <div className="ml-auto"><Button variant="ghost" size="sm" onClick={reset} disabled={!messages.length}><RotateCcw className="mr-1 h-3.5 w-3.5"/>新对话</Button></div>
        </div>
        {!messages.length ? (
          <div className="mt-6">
            <p className="mb-3 text-sm text-slate-600">你可以直接用中文或英文提问，例如：</p>
            <div className="grid gap-2 md:grid-cols-2">
              {suggestions.map((s) => <button key={s} onClick={() => send(s)} className="rounded-lg border px-3 py-3 text-left text-sm text-slate-700 transition hover:border-violet-300 hover:bg-violet-50">{s}</button>)}
            </div>
          </div>
        ) : (
          <div className="mt-5 max-h-[58vh] space-y-4 overflow-y-auto pr-1">
            {messages.map((m,i) => <div key={i} className={m.role === 'user' ? 'ml-8 rounded-xl bg-blue-50 p-3' : 'mr-4 rounded-xl border bg-slate-50 p-4'}>
              <div className="mb-1 text-[11px] font-semibold text-slate-500">{m.role === 'user' ? '你' : 'AI 业务助手'}</div>
              <div className="whitespace-pre-wrap text-sm leading-6 text-slate-800">{m.content}</div>
              {!!m.entities?.length && <div className="mt-3 flex flex-wrap gap-2">{m.entities.map(e => <span key={`${e.type}:${e.id}`} className="inline-flex items-center gap-1.5 rounded-md border bg-white px-2.5 py-1.5 text-xs text-blue-700"><EntityIcon type={e.type}/>{entityLabels[e.type] ?? e.type} · <button onClick={() => openEntity(e)} className="underline underline-offset-2">打开记录</button>{e.type === 'inquiry' && e.customerId && <><span className="text-slate-300">|</span><button onClick={() => emailDraftMutation.mutate(e)} disabled={emailDraftMutation.isPending} className="font-semibold text-violet-700 hover:underline disabled:opacity-50">{emailDraftMutation.isPending ? '生成中…' : '生成邮件草稿'}</button></>}</span>)}</div>}
              {!!m.missingInfo?.length && <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"><div className="mb-1 font-semibold">还需要人工确认</div>{m.missingInfo.map((x,j)=><div key={j}>• {x}</div>)}</div>}
            </div>)}
            {mutation.isPending && <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin"/>正在检索业务资料并分析…</div>}
          </div>
        )}
      </section>
      <form className="flex gap-2 rounded-xl border bg-white p-3" onSubmit={e=>{e.preventDefault();send()}}>
        <Input value={input} onChange={e=>setInput(e.target.value)} placeholder="问产品、客户、询盘、报价、订单或供应商……" disabled={mutation.isPending}/>
        <Button type="submit" disabled={!input.trim() || mutation.isPending}><Send className="mr-1 h-4 w-4"/>发送</Button>
      </form>
      <p className="px-1 text-[11px] text-slate-400">AI 只根据 Workbench 已保存的数据回答。未录入的信息会明确标为缺失；任何报价、客户资料、订单或邮件操作都需要你在原业务页面手动确认。</p>
    </div>
  )
}
