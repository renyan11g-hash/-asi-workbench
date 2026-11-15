import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, ArrowRight, CheckCircle2, CircleAlert, ClipboardList, DollarSign, Package, Plus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { businessOpsApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

const centers = [
  { title:'产品中心', desc:'市场选品、供应商、产品资料、Listing 与图片', links:[['选品预估','/sourcing-suggest'],['产品流水线','/pipeline'],['产品资料库','/master-data'],['Listing 审核','/listing-reviews'],['正式产品库','/library']] },
  { title:'客户销售中心', desc:'客户档案、询盘、报价邮件与销售推进', links:[['客户档案','/order-center?tab=customers'],['询盘与报价','/order-center?tab=inquiries'],['邮件草稿','/order-center?tab=emails'],['客户跟进待办','/business-ops']] },
  { title:'订单交付中心', desc:'订单状态、生产、物流、付款与售后', links:[['订单管理','/order-center?tab=orders'],['物流 / 收款 / 售后','/order-center?tab=fulfillment'],['生产进度','/production'],['成本与提成','/order-costs']] },
  { title:'经营分析中心', desc:'成本完整度、订单利润、提成与经营数据', links:[['经营分析总览','/business-ops'],['录入订单成本','/order-costs']] },
  { title:'工作任务中心', desc:'把客户跟进、报价提醒和订单节点放进统一待办', links:[['今日工作台','/business-ops']] },
]

function money(value: unknown) {
  return Number(value ?? 0).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2})
}

export default function BusinessHub() {
  const qc = useQueryClient()
  const [title,setTitle] = useState('')
  const [dueAt,setDueAt] = useState(()=>{ const d=new Date(); d.setHours(d.getHours()+1); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16) })
  const [description,setDescription] = useState('')
  const overview = useQuery({queryKey:['business-ops-overview'],queryFn:businessOpsApi.overview,refetchInterval:30000})
  const tasks = useQuery({queryKey:['business-ops-tasks'],queryFn:()=>businessOpsApi.listTasks('open'),refetchInterval:30000})
  const performance = useQuery({queryKey:['business-ops-performance'],queryFn:businessOpsApi.performance})
  const createTask = useMutation({
    mutationFn:()=>businessOpsApi.createTask({title,description,dueAt:new Date(dueAt).toISOString(),priority:'normal'}),
    onSuccess:()=>{setTitle('');setDescription('');qc.invalidateQueries({queryKey:['business-ops-tasks']});qc.invalidateQueries({queryKey:['business-ops-overview']});toast.success('待办已创建')},
    onError:()=>toast.error('创建失败，请检查输入后重试')
  })
  const completeTask = useMutation({
    mutationFn:(id:string)=>businessOpsApi.updateTask(id,{status:'done'}),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['business-ops-tasks']});qc.invalidateQueries({queryKey:['business-ops-overview']})}
  })
  const o=overview.data
  const p=performance.data
  const stats=[
    ['产品档案',o?.products??'—',Package],['客户',o?.customers??'—',Users],['新询盘',o?.newInquiries??'—',Activity],
    ['进行中订单',o?.activeOrders??'—',ClipboardList],['待收款订单',o?.unpaidOrders??'—',DollarSign],['逾期任务',o?.overdueTasks??'—',CircleAlert],
  ] as const
  return <div className="space-y-6">
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {stats.map(([label,value,Icon])=><div key={label} className="rounded-xl border bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between text-sm text-slate-500"><span>{label}</span><Icon className="h-4 w-4"/></div>
        <div className="mt-2 text-2xl font-semibold">{value}</div>
      </div>)}
    </section>
    <section>
      <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">业务中心</h2><span className="text-xs text-slate-500">按实际工作流程组织</span></div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {centers.map(center=><div key={center.title} className="rounded-xl border bg-white p-4">
          <h3 className="font-semibold">{center.title}</h3><p className="mt-1 text-xs text-slate-500">{center.desc}</p>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2">{center.links.map(([label,to])=><Link key={label} to={to} className="inline-flex items-center text-xs text-blue-700 hover:underline">{label}<ArrowRight className="ml-1 h-3 w-3"/></Link>)}</div>
        </div>)}
      </div>
    </section>
    <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-xl border bg-white p-5">
        <div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">待办事项</h2><p className="mt-1 text-xs text-slate-500">客户跟进、报价提醒和交付节点统一放在这里</p></div><span className="rounded-full bg-slate-100 px-2 py-1 text-xs">{tasks.data?.tasks.length??0} 项待处理</span></div>
        <div className="space-y-2">
          {(tasks.data?.tasks??[]).map((task:any)=><div key={task.id} className="flex items-start gap-3 rounded-lg border p-3">
            <button title="标记完成" onClick={()=>completeTask.mutate(task.id)} className="mt-0.5 text-slate-400 hover:text-emerald-600"><CheckCircle2 className="h-4 w-4"/></button>
            <div className="min-w-0 flex-1"><div className="text-sm font-medium">{task.title}</div>{task.description&&<p className="mt-1 text-xs text-slate-500">{task.description}</p>}<p className="mt-1 text-[11px] text-slate-400">截止：{String(task.due_at).replace('T',' ').slice(0,16)} · {task.priority==='high'?'高优先级':'普通'}</p></div>
          </div>)}
          {!tasks.isLoading&&(tasks.data?.tasks.length??0)===0&&<div className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-400">当前没有待办，先把下一次客户跟进时间记下来</div>}
        </div>
      </div>
      <div className="rounded-xl border bg-white p-5">
        <h2 className="font-semibold">快速添加待办</h2>
        <form className="mt-4 space-y-3" onSubmit={e=>{e.preventDefault();if(title.trim())createTask.mutate()}}>
          <div><Label htmlFor="task-title">事项</Label><Input id="task-title" value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：跟进客户的更新报价" required/></div>
          <div><Label htmlFor="task-due">提醒时间</Label><Input id="task-due" type="datetime-local" value={dueAt} onChange={e=>setDueAt(e.target.value)} required/></div>
          <div><Label htmlFor="task-desc">备注</Label><Textarea id="task-desc" value={description} onChange={e=>setDescription(e.target.value)} placeholder="客户、产品、下一步动作…" rows={3}/></div>
          <Button type="submit" disabled={createTask.isPending||!title.trim()} className="w-full"><Plus className="mr-1 h-4 w-4"/>添加待办</Button>
        </form>
      </div>
    </section>
    <section className="rounded-xl border bg-white p-5">
      <div className="mb-3 flex items-center justify-between"><div><h2 className="font-semibold">订单经营数据</h2><p className="mt-1 text-xs text-slate-500">只有录入完整成本的订单才纳入利润和提成合计，避免把缺失成本当成零</p></div><Link to="/order-center" className="text-xs text-blue-700 hover:underline">打开订单中心</Link></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">已录成本订单</div><div className="mt-1 text-xl font-semibold">{p?.summary?.costRecordedCount??'—'}</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">待补成本订单</div><div className="mt-1 text-xl font-semibold">{p?.summary?.untrackedCount??'—'}</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">已核算毛利润</div><div className="mt-1 text-xl font-semibold">{p?money(p.summary.profitUsd):'—'}</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">预估提成</div><div className="mt-1 text-xl font-semibold">{p?money(p.summary.commissionUsd):'—'}</div></div>
      </div>
      {p?.note&&<p className="mt-3 text-xs text-amber-700">{p.note}</p>}
      <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b text-slate-500"><tr><th className="py-2">订单号</th><th>客户</th><th>销售额</th><th>成本</th><th>毛利润</th><th>提成</th><th>成本状态</th></tr></thead><tbody>
        {(p?.details??[]).slice(0,8).map((r:any)=><tr key={r.orderId} className="border-b last:border-0"><td className="py-2 font-medium">{r.orderNumber}</td><td>{r.customerName}</td><td>{money(r.revenueUsd)}</td><td>{r.costRecorded?money(r.costUsd):'—'}</td><td>{r.profitUsd==null?'—':money(r.profitUsd)}</td><td>{r.commission==null?'—':money(r.commission)}</td><td>{r.costRecorded?'已录入':'待补成本'}</td></tr>)}
      </tbody></table></div>
    </section>
  </div>
}
