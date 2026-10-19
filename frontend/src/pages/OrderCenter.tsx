import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Building2,
  ClipboardList,
  Loader2,
  Mail,
  MessageSquare,
  Package,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { SectionCard } from '@/components/ui/primitives'
import { api, orderApi, getErrorMessage } from '@/lib/api'
import {
  Customer,
  CustomerType,
  InquiryStatus,
  InquiryType,
  OrderStatus,
  PaymentStatus,
  Product,
  SupplierCommunication,
} from '@/types'

// ---------- 状态徽章 ----------
const INQUIRY_STATUS: Record<InquiryStatus, { label: string; cls: string }> = {
  new: { label: '新询盘', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  responded: { label: '已回复', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  quoted: { label: '已报价', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  converted: { label: '已转订单', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  closed: { label: '已关闭', cls: 'bg-slate-100 text-slate-400 border-slate-200' },
}

const ORDER_STATUS: Record<OrderStatus, { label: string; cls: string }> = {
  pending: { label: '待确认', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  confirmed: { label: '已确认', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  production: { label: '生产中', cls: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  shipped: { label: '已发货', cls: 'bg-cyan-100 text-cyan-700 border-cyan-200' },
  delivered: { label: '已送达', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  cancelled: { label: '已取消', cls: 'bg-slate-100 text-slate-400 border-slate-200' },
}

const PAYMENT_STATUS: Record<PaymentStatus, { label: string; cls: string }> = {
  unpaid: { label: '未付款', cls: 'bg-rose-100 text-rose-700 border-rose-200' },
  partial: { label: '部分付款', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  paid: { label: '已付款', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  overdue: { label: '逾期', cls: 'bg-rose-100 text-rose-700 border-rose-200' },
}

const CUSTOMER_TYPE: Record<CustomerType, string> = {
  distributor: '分销商',
  retailer: '零售商',
  corporate: '企业客户',
  individual: '个人',
}

const INQUIRY_TYPE: Record<InquiryType, string> = {
  price_inquiry: '价格询盘',
  custom_quote: '定制报价',
  sample_request: '样品申请',
  general_question: '一般咨询',
}

const CONTACT_METHOD: Record<string, string> = {
  email: '邮件',
  phone: '电话',
  wechat: '微信',
  other: '其他',
}

function BadgeOf({ map, value }: { map: Record<string, { label: string; cls: string }>; value: string }) {
  const item = map[value] ?? { label: value, cls: 'bg-slate-100 text-slate-600 border-slate-200' }
  return <Badge variant="outline" className={`whitespace-nowrap ${item.cls}`}>{item.label}</Badge>
}

const fmtUsd = (n: number) => `$${n.toFixed(2)}`
const fmtDate = (s: string) => (s ? s.slice(0, 10) : '-')

// ---------- 订单运营中心 ----------
export default function OrderCenter() {
  const qc = useQueryClient()
  const [tab, setTab] = useState('dashboard')

  const invalidate = (keys: string[]) => {
    for (const k of keys) void qc.invalidateQueries({ queryKey: [k] })
  }

  // 产品列表（询盘/订单/供应商沟通关联用）
  const { data: products } = useQuery({
    queryKey: ['products-all'],
    queryFn: () => api.listProducts(),
  })
  const productList: Product[] = products ?? []

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="dashboard"><Package className="mr-1 h-3.5 w-3.5" />数据看板</TabsTrigger>
          <TabsTrigger value="customers"><Users className="mr-1 h-3.5 w-3.5" />客户管理</TabsTrigger>
          <TabsTrigger value="inquiries"><ClipboardList className="mr-1 h-3.5 w-3.5" />询盘管理</TabsTrigger>
          <TabsTrigger value="orders"><Building2 className="mr-1 h-3.5 w-3.5" />订单管理</TabsTrigger>
          <TabsTrigger value="communications"><MessageSquare className="mr-1 h-3.5 w-3.5" />供应商沟通</TabsTrigger>
          <TabsTrigger value="emails"><Mail className="mr-1 h-3.5 w-3.5" />邮件草稿</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-4">
          <DashboardTab onGoTab={setTab} />
        </TabsContent>
        <TabsContent value="customers" className="mt-4">
          <CustomersTab onChanged={() => invalidate(['oc-overview', 'oc-tasks'])} />
        </TabsContent>
        <TabsContent value="inquiries" className="mt-4">
          <InquiriesTab products={productList} onChanged={() => invalidate(['oc-overview', 'oc-tasks'])} />
        </TabsContent>
        <TabsContent value="orders" className="mt-4">
          <OrdersTab products={productList} onChanged={() => invalidate(['oc-overview', 'oc-tasks'])} />
        </TabsContent>
        <TabsContent value="communications" className="mt-4">
          <CommunicationsTab products={productList} />
        </TabsContent>
        <TabsContent value="emails" className="mt-4">
          <EmailsTab onChanged={() => invalidate(['oc-inquiries'])} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------- Dashboard Tab ----------
function DashboardTab({ onGoTab }: { onGoTab: (t: string) => void }) {
  const { data: ov, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['oc-overview'],
    queryFn: orderApi.dashboardOverview,
  })
  const { data: tasks } = useQuery({
    queryKey: ['oc-tasks'],
    queryFn: orderApi.pendingTasks,
  })

  if (isLoading || !ov) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
      </div>
    )
  }

  const cards = [
    { label: '客户总数', value: String(ov.customers.total), tone: 'text-slate-900' },
    { label: '询盘总数', value: String(ov.inquiries.total), tone: 'text-slate-900' },
    { label: '新询盘', value: String(ov.inquiries.new), tone: 'text-blue-600' },
    { label: '订单总数', value: String(ov.orders.total), tone: 'text-slate-900' },
    { label: '订单总金额', value: fmtUsd(ov.orders.totalRevenue), tone: 'text-emerald-600' },
    { label: '待收款订单', value: String(ov.orders.unpaid), tone: 'text-rose-600' },
    { label: '产品总数', value: String(ov.products.total), tone: 'text-slate-900' },
  ]

  return (
    <div className="space-y-4">
      <SectionCard
        title="运营概览"
        hint="客户、询盘、订单与收款的整体情况"
        right={
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isRefetching}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          {cards.map((c) => (
            <div key={c.label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="text-[11px] text-slate-500">{c.label}</div>
              <div className={`mt-1 text-lg font-bold ${c.tone}`}>{c.value}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600">
            询盘已回复 <span className="font-semibold text-slate-900">{ov.inquiries.responded}</span>
          </div>
          <div className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600">
            询盘已转订单 <span className="font-semibold text-slate-900">{ov.inquiries.converted}</span>
          </div>
          <div className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600">
            待确认订单 <span className="font-semibold text-slate-900">{ov.orders.pending}</span>
          </div>
          <div className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600">
            生产中订单 <span className="font-semibold text-slate-900">{ov.orders.production}</span>
          </div>
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="新询盘待处理" hint="最近 10 条未回复询盘">
          {(tasks?.newInquiries?.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">暂无待处理询盘</p>
          ) : (
            <div className="space-y-2">
              {tasks!.newInquiries.map((i) => (
                <div key={i.inquiryId} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="text-xs font-medium text-slate-800">{i.subject}</div>
                  <div className="mt-0.5 text-[11px] text-slate-400">{i.customerName} · {fmtDate(i.createdAt)}</div>
                </div>
              ))}
            </div>
          )}
          <Button variant="link" size="sm" className="mt-2 px-0" onClick={() => onGoTab('inquiries')}>
            去处理询盘 →
          </Button>
        </SectionCard>

        <SectionCard title="待确认订单" hint="最近 10 条待确认订单">
          {(tasks?.pendingOrders?.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">暂无待确认订单</p>
          ) : (
            <div className="space-y-2">
              {tasks!.pendingOrders.map((o) => (
                <div key={o.orderId} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="text-xs font-medium text-slate-800">{o.orderNumber} · {fmtUsd(o.totalAmount)}</div>
                  <div className="mt-0.5 text-[11px] text-slate-400">{o.customerName} · {fmtDate(o.createdAt)}</div>
                </div>
              ))}
            </div>
          )}
          <Button variant="link" size="sm" className="mt-2 px-0" onClick={() => onGoTab('orders')}>
            去处理订单 →
          </Button>
        </SectionCard>

        <SectionCard title="待收款订单" hint="最近 10 条未收款订单">
          {(tasks?.unpaidOrders?.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">暂无待收款订单</p>
          ) : (
            <div className="space-y-2">
              {tasks!.unpaidOrders.map((o) => (
                <div key={o.orderId} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="text-xs font-medium text-slate-800">
                    {o.orderNumber} · {fmtUsd(o.totalAmount)}
                    {o.depositAmount ? <span className="ml-1 text-[11px] text-slate-400">（定金 {fmtUsd(o.depositAmount)}）</span> : null}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-400">{o.customerName} · {fmtDate(o.createdAt)}</div>
                </div>
              ))}
            </div>
          )}
          <Button variant="link" size="sm" className="mt-2 px-0" onClick={() => onGoTab('orders')}>
            去收款 →
          </Button>
        </SectionCard>
      </div>
    </div>
  )
}

// ---------- 客户 Tab ----------
function CustomersTab({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', company: '', email: '', phone: '', country: '', type: 'individual' as CustomerType, notes: '' })

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['oc-customers', q],
    queryFn: () => (q.trim() ? orderApi.searchCustomers(q.trim()) : orderApi.listCustomers()),
  })
  const customers = data ?? []

  const openCreate = () => {
    setEditing(null)
    setForm({ name: '', company: '', email: '', phone: '', country: '', type: 'individual', notes: '' })
    setDialogOpen(true)
  }
  const openEdit = (c: Customer) => {
    setEditing(c)
    setForm({ name: c.name, company: c.company ?? '', email: c.email, phone: c.phone ?? '', country: c.country ?? '', type: c.type, notes: c.notes ?? '' })
    setDialogOpen(true)
  }

  const save = useMutation({
    mutationFn: async () => {
      if (editing) return orderApi.updateCustomer(editing.id, form)
      return orderApi.createCustomer(form)
    },
    onSuccess: () => {
      toast.success(editing ? '客户已更新' : '客户已创建')
      setDialogOpen(false)
      void qc.invalidateQueries({ queryKey: ['oc-customers'] })
      onChanged()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const remove = async (id: string) => {
    setDeletingId(id)
    try {
      await orderApi.deleteCustomer(id)
      toast.success('客户已删除')
      void qc.invalidateQueries({ queryKey: ['oc-customers'] })
      onChanged()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <SectionCard
      title="客户管理"
      hint="分销商 / 零售商 / 企业 / 个人客户统一管理"
      right={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isRefetching}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
          </Button>
          <Button size="sm" onClick={openCreate}><Plus className="mr-1 h-3.5 w-3.5" /> 新建客户</Button>
        </div>
      }
    >
      <div className="mb-3">
        <Input placeholder="搜索姓名 / 公司 / 邮箱…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-sm text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
        </div>
      ) : customers.length === 0 ? (
        <p className="py-12 text-center text-sm text-slate-400">还没有客户，点「新建客户」添加</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>姓名</TableHead>
              <TableHead>公司</TableHead>
              <TableHead>邮箱</TableHead>
              <TableHead>电话</TableHead>
              <TableHead>国家</TableHead>
              <TableHead>类型</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell>{c.company || '-'}</TableCell>
                <TableCell className="text-slate-500">{c.email}</TableCell>
                <TableCell>{c.phone || '-'}</TableCell>
                <TableCell>{c.country || '-'}</TableCell>
                <TableCell><Badge variant="secondary">{CUSTOMER_TYPE[c.type]}</Badge></TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>编辑</Button>
                    <Button variant="ghost" size="sm" className="text-rose-600" onClick={() => void remove(c.id)} disabled={deletingId === c.id}>
                      {deletingId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑客户' : '新建客户'}</DialogTitle>
            <DialogDescription>客户邮箱唯一；有关联询盘/订单的客户不可删除</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>姓名 *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>公司</Label>
              <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>邮箱 *</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>电话</Label>
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label>国家</Label>
                <Input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="US" />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>客户类型</Label>
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as CustomerType })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(CUSTOMER_TYPE) as CustomerType[]).map((t) => (
                    <SelectItem key={t} value={t}>{CUSTOMER_TYPE[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>备注</Label>
              <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim() || !form.email.trim()}>
              {save.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  )
}

// ---------- 询盘 Tab ----------
function InquiriesTab({ products, onChanged }: { products: Product[]; onChanged: () => void }) {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [categorizingId, setCategorizingId] = useState<string | null>(null)
  const [form, setForm] = useState({ customerId: '', subject: '', content: '', type: 'price_inquiry' as InquiryType, productId: '' })

  const { data: customers } = useQuery({ queryKey: ['oc-customers', ''], queryFn: () => orderApi.listCustomers() })
  const customerList = customers ?? []

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['oc-inquiries', statusFilter],
    queryFn: () => orderApi.listInquiries(statusFilter === 'all' ? undefined : { status: statusFilter }),
  })
  const inquiries = data ?? []

  const openCreate = () => {
    setForm({ customerId: customerList[0]?.id ?? '', subject: '', content: '', type: 'price_inquiry', productId: '' })
    setDialogOpen(true)
  }

  const create = useMutation({
    mutationFn: () =>
      orderApi.createInquiry({
        customerId: form.customerId,
        subject: form.subject,
        content: form.content,
        type: form.type,
        productId: form.productId || undefined,
      }),
    onSuccess: () => {
      toast.success('询盘已创建')
      setDialogOpen(false)
      void qc.invalidateQueries({ queryKey: ['oc-inquiries'] })
      onChanged()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: InquiryStatus }) => orderApi.updateInquiryStatus(id, status),
    onSuccess: () => {
      toast.success('询盘状态已更新')
      void qc.invalidateQueries({ queryKey: ['oc-inquiries'] })
      onChanged()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const categorize = async (id: string) => {
    setCategorizingId(id)
    try {
      const inq = await orderApi.categorizeInquiry(id)
      toast.success(`AI 分类完成：${inq.aiCategory ?? 'general'}`)
      void qc.invalidateQueries({ queryKey: ['oc-inquiries'] })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setCategorizingId(null)
    }
  }

  const remove = async (id: string) => {
    setDeletingId(id)
    try {
      await orderApi.deleteInquiry(id)
      toast.success('询盘已删除')
      void qc.invalidateQueries({ queryKey: ['oc-inquiries'] })
      onChanged()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDeletingId(null)
    }
  }

  const customerName = (id: string) => customerList.find((c) => c.id === id)?.name ?? id.slice(0, 8)
  const productTitle = (id?: string) => (id ? products.find((p) => p.id === id)?.source.sourceTitle || '-' : '-')

  return (
    <SectionCard
      title="询盘管理"
      hint="客户询盘集中处理：回复、报价、转订单"
      right={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isRefetching}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
          </Button>
          <Button size="sm" onClick={openCreate} disabled={customerList.length === 0}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 新建询盘
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <Label className="text-xs text-slate-500">状态筛选</Label>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            {(Object.keys(INQUIRY_STATUS) as InquiryStatus[]).map((s) => (
              <SelectItem key={s} value={s}>{INQUIRY_STATUS[s].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {customerList.length === 0 && <span className="text-xs text-amber-600">请先在「客户管理」创建客户</span>}
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-sm text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
        </div>
      ) : inquiries.length === 0 ? (
        <p className="py-12 text-center text-sm text-slate-400">暂无询盘</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>主题</TableHead>
              <TableHead>客户</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>关联产品</TableHead>
              <TableHead>AI 分类</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>日期</TableHead>
              <TableHead className="w-40 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inquiries.map((i) => (
              <TableRow key={i.id}>
                <TableCell className="max-w-48 truncate font-medium" title={i.subject}>{i.subject}</TableCell>
                <TableCell>{customerName(i.customerId)}</TableCell>
                <TableCell><Badge variant="secondary">{INQUIRY_TYPE[i.type]}</Badge></TableCell>
                <TableCell className="max-w-40 truncate text-slate-500" title={productTitle(i.productId)}>{productTitle(i.productId)}</TableCell>
                <TableCell>{i.aiCategory ? <Badge variant="outline">{i.aiCategory}</Badge> : '-'}</TableCell>
                <TableCell><BadgeOf map={INQUIRY_STATUS} value={i.status} /></TableCell>
                <TableCell className="text-slate-400">{fmtDate(i.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Select value={i.status} onValueChange={(v) => setStatus.mutate({ id: i.id, status: v as InquiryStatus })}>
                      <SelectTrigger className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(Object.keys(INQUIRY_STATUS) as InquiryStatus[]).map((s) => (
                          <SelectItem key={s} value={s}>{INQUIRY_STATUS[s].label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="sm" title="AI 分类" onClick={() => void categorize(i.id)} disabled={categorizingId === i.id}>
                      {categorizingId === i.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-rose-600" onClick={() => void remove(i.id)} disabled={deletingId === i.id}>
                      {deletingId === i.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>新建询盘</DialogTitle>
            <DialogDescription>记录客户的询盘内容，可关联产品</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>客户 *</Label>
              <Select value={form.customerId} onValueChange={(v) => setForm({ ...form, customerId: v })}>
                <SelectTrigger><SelectValue placeholder="选择客户" /></SelectTrigger>
                <SelectContent>
                  {customerList.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}{c.company ? `（${c.company}）` : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>主题 *</Label>
              <Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>内容 *</Label>
              <Textarea rows={4} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>询盘类型</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as InquiryType })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(INQUIRY_TYPE) as InquiryType[]).map((t) => (
                      <SelectItem key={t} value={t}>{INQUIRY_TYPE[t]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>关联产品</Label>
                <Select value={form.productId || 'none'} onValueChange={(v) => setForm({ ...form, productId: v === 'none' ? '' : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不关联</SelectItem>
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.source.sourceTitle.slice(0, 30) || p.id.slice(0, 8)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.customerId || !form.subject.trim() || !form.content.trim()}>
              {create.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  )
}

// ---------- 订单 Tab ----------
function OrdersTab({ products, onChanged }: { products: Product[]; onChanged: () => void }) {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [form, setForm] = useState({
    customerId: '',
    orderNumber: '',
    totalAmount: '',
    depositAmount: '',
    balanceAmount: '',
    notes: '',
    items: [{ productId: '', quantity: '100', unitPrice: '' }],
  })

  const { data: customers } = useQuery({ queryKey: ['oc-customers', ''], queryFn: () => orderApi.listCustomers() })
  const customerList = customers ?? []

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['oc-orders', statusFilter],
    queryFn: () => orderApi.listOrders(statusFilter === 'all' ? undefined : { status: statusFilter }),
  })
  const orders = data ?? []

  const openCreate = () => {
    setForm({
      customerId: customerList[0]?.id ?? '',
      orderNumber: `SO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Math.floor(Math.random() * 900) + 100)}`,
      totalAmount: '',
      depositAmount: '',
      balanceAmount: '',
      notes: '',
      items: [{ productId: products[0]?.id ?? '', quantity: '100', unitPrice: '' }],
    })
    setDialogOpen(true)
  }

  const create = useMutation({
    mutationFn: () => {
      const items = form.items
        .filter((it) => it.productId && Number(it.quantity) > 0 && Number(it.unitPrice) > 0)
        .map((it) => ({ productId: it.productId, quantity: Number(it.quantity), unitPrice: Number(it.unitPrice) }))
      return orderApi.createOrder({
        customerId: form.customerId,
        orderNumber: form.orderNumber,
        totalAmount: form.totalAmount ? Number(form.totalAmount) : undefined,
        depositAmount: form.depositAmount ? Number(form.depositAmount) : undefined,
        balanceAmount: form.balanceAmount ? Number(form.balanceAmount) : undefined,
        notes: form.notes || undefined,
        items,
      })
    },
    onSuccess: () => {
      toast.success('订单已创建')
      setDialogOpen(false)
      void qc.invalidateQueries({ queryKey: ['oc-orders'] })
      onChanged()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: OrderStatus }) => orderApi.updateOrderStatus(id, status),
    onSuccess: () => {
      toast.success('订单状态已更新')
      void qc.invalidateQueries({ queryKey: ['oc-orders'] })
      onChanged()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const setPayment = useMutation({
    mutationFn: ({ id, paymentStatus }: { id: string; paymentStatus: PaymentStatus }) =>
      orderApi.updateOrderPaymentStatus(id, paymentStatus),
    onSuccess: () => {
      toast.success('付款状态已更新')
      void qc.invalidateQueries({ queryKey: ['oc-orders'] })
      onChanged()
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const remove = async (id: string) => {
    setDeletingId(id)
    try {
      await orderApi.deleteOrder(id)
      toast.success('订单已删除')
      void qc.invalidateQueries({ queryKey: ['oc-orders'] })
      onChanged()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDeletingId(null)
    }
  }

  const customerName = (id: string) => customerList.find((c) => c.id === id)?.name ?? id.slice(0, 8)
  const validItems = form.items.filter((it) => it.productId && Number(it.quantity) > 0 && Number(it.unitPrice) > 0)
  const calcTotal = validItems.reduce((s, it) => s + Number(it.quantity) * Number(it.unitPrice), 0)

  return (
    <SectionCard
      title="订单管理"
      hint="订单全流程：待确认 → 已确认 → 生产 → 发货 → 送达"
      right={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isRefetching}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
          </Button>
          <Button size="sm" onClick={openCreate} disabled={customerList.length === 0 || products.length === 0}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 新建订单
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <Label className="text-xs text-slate-500">状态筛选</Label>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            {(Object.keys(ORDER_STATUS) as OrderStatus[]).map((s) => (
              <SelectItem key={s} value={s}>{ORDER_STATUS[s].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(customerList.length === 0 || products.length === 0) && (
          <span className="text-xs text-amber-600">需要先有客户和产品才能创建订单</span>
        )}
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-sm text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
        </div>
      ) : orders.length === 0 ? (
        <p className="py-12 text-center text-sm text-slate-400">暂无订单</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>订单号</TableHead>
              <TableHead>客户</TableHead>
              <TableHead>总金额</TableHead>
              <TableHead>定金</TableHead>
              <TableHead>订单状态</TableHead>
              <TableHead>付款状态</TableHead>
              <TableHead>日期</TableHead>
              <TableHead className="w-44 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-medium">{o.orderNumber}</TableCell>
                <TableCell>{customerName(o.customerId)}</TableCell>
                <TableCell className="font-semibold text-emerald-700">{fmtUsd(o.totalAmount)}</TableCell>
                <TableCell>{o.depositAmount ? fmtUsd(o.depositAmount) : '-'}</TableCell>
                <TableCell>
                  <Select value={o.status} onValueChange={(v) => setStatus.mutate({ id: o.id, status: v as OrderStatus })}>
                    <SelectTrigger className="h-7 w-28 border-0 p-0 text-xs shadow-none focus:ring-0"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ORDER_STATUS) as OrderStatus[]).map((s) => (
                        <SelectItem key={s} value={s}>{ORDER_STATUS[s].label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Select value={o.paymentStatus} onValueChange={(v) => setPayment.mutate({ id: o.id, paymentStatus: v as PaymentStatus })}>
                    <SelectTrigger className="h-7 w-28 border-0 p-0 text-xs shadow-none focus:ring-0"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(PAYMENT_STATUS) as PaymentStatus[]).map((s) => (
                        <SelectItem key={s} value={s}>{PAYMENT_STATUS[s].label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-slate-400">{fmtDate(o.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-rose-600"
                    onClick={() => void remove(o.id)}
                    disabled={deletingId === o.id || o.status !== 'pending'}
                    title={o.status !== 'pending' ? '只能删除待确认的订单' : '删除订单'}
                  >
                    {deletingId === o.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>新建订单</DialogTitle>
            <DialogDescription>至少一个产品明细；总金额留空时按明细自动计算</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>客户 *</Label>
                <Select value={form.customerId} onValueChange={(v) => setForm({ ...form, customerId: v })}>
                  <SelectTrigger><SelectValue placeholder="选择客户" /></SelectTrigger>
                  <SelectContent>
                    {customerList.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}{c.company ? `（${c.company}）` : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>订单号 *</Label>
                <Input value={form.orderNumber} onChange={(e) => setForm({ ...form, orderNumber: e.target.value })} />
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 flex items-center justify-between">
                <Label className="text-xs font-semibold text-slate-700">产品明细</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setForm({ ...form, items: [...form.items, { productId: products[0]?.id ?? '', quantity: '100', unitPrice: '' }] })}
                >
                  <Plus className="mr-1 h-3 w-3" /> 添加明细
                </Button>
              </div>
              <div className="space-y-2">
                {form.items.map((it, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_80px_100px_32px] items-center gap-2">
                    <Select
                      value={it.productId || undefined}
                      onValueChange={(v) => {
                        const items = [...form.items]
                        items[idx] = { ...items[idx], productId: v }
                        setForm({ ...form, items })
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="选择产品" /></SelectTrigger>
                      <SelectContent>
                        {products.map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.source.sourceTitle.slice(0, 30) || p.id.slice(0, 8)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      className="h-8 text-xs"
                      type="number"
                      min={1}
                      placeholder="数量"
                      value={it.quantity}
                      onChange={(e) => {
                        const items = [...form.items]
                        items[idx] = { ...items[idx], quantity: e.target.value }
                        setForm({ ...form, items })
                      }}
                    />
                    <Input
                      className="h-8 text-xs"
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="单价 $"
                      value={it.unitPrice}
                      onChange={(e) => {
                        const items = [...form.items]
                        items[idx] = { ...items[idx], unitPrice: e.target.value }
                        setForm({ ...form, items })
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-rose-600"
                      disabled={form.items.length <= 1}
                      onClick={() => setForm({ ...form, items: form.items.filter((_, i) => i !== idx) })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              {calcTotal > 0 && (
                <p className="mt-2 text-xs text-slate-500">明细合计：<span className="font-semibold text-slate-800">{fmtUsd(calcTotal)}</span></p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label>总金额 $（留空自动算）</Label>
                <Input type="number" min={0} step="0.01" value={form.totalAmount} onChange={(e) => setForm({ ...form, totalAmount: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label>定金 $</Label>
                <Input type="number" min={0} step="0.01" value={form.depositAmount} onChange={(e) => setForm({ ...form, depositAmount: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label>尾款 $</Label>
                <Input type="number" min={0} step="0.01" value={form.balanceAmount} onChange={(e) => setForm({ ...form, balanceAmount: e.target.value })} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>备注</Label>
              <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.customerId || !form.orderNumber.trim() || validItems.length === 0}>
              {create.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 创建订单
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  )
}

// ---------- 供应商沟通 Tab ----------
function CommunicationsTab({ products }: { products: Product[] }) {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [form, setForm] = useState({ productId: '', supplierName: '', contactMethod: 'email' as SupplierCommunication['contactMethod'], content: '', response: '', priceCny: '', moq: '', leadTime: '' })

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['oc-comms'],
    queryFn: () => orderApi.listCommunications(),
  })
  const comms = data ?? []

  const openCreate = () => {
    setForm({ productId: products[0]?.id ?? '', supplierName: '', contactMethod: 'email', content: '', response: '', priceCny: '', moq: '', leadTime: '' })
    setDialogOpen(true)
  }

  const create = useMutation({
    mutationFn: () =>
      orderApi.createCommunication({
        productId: form.productId,
        supplierName: form.supplierName,
        contactMethod: form.contactMethod,
        content: form.content,
        response: form.response || undefined,
        priceCny: form.priceCny ? Number(form.priceCny) : undefined,
        moq: form.moq ? Number(form.moq) : undefined,
        leadTime: form.leadTime || undefined,
      }),
    onSuccess: () => {
      toast.success('沟通记录已保存')
      setDialogOpen(false)
      void qc.invalidateQueries({ queryKey: ['oc-comms'] })
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const remove = async (id: string) => {
    setDeletingId(id)
    try {
      await orderApi.deleteCommunication(id)
      toast.success('沟通记录已删除')
      void qc.invalidateQueries({ queryKey: ['oc-comms'] })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDeletingId(null)
    }
  }

  const productTitle = (id: string) => products.find((p) => p.id === id)?.source.sourceTitle || id.slice(0, 8)

  return (
    <SectionCard
      title="供应商沟通记录"
      hint="记录 1688 供应商的报价、起订量与交货周期，方便比价"
      right={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isRefetching}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
          </Button>
          <Button size="sm" onClick={openCreate} disabled={products.length === 0}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 新建记录
          </Button>
        </div>
      }
    >
      {products.length === 0 && <p className="mb-3 text-xs text-amber-600">需要先在产品库有产品才能记录沟通</p>}
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-sm text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
        </div>
      ) : comms.length === 0 ? (
        <p className="py-12 text-center text-sm text-slate-400">暂无沟通记录</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>产品</TableHead>
              <TableHead>供应商</TableHead>
              <TableHead>方式</TableHead>
              <TableHead>报价（¥）</TableHead>
              <TableHead>MOQ</TableHead>
              <TableHead>交期</TableHead>
              <TableHead>沟通内容</TableHead>
              <TableHead>日期</TableHead>
              <TableHead className="w-16 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {comms.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="max-w-40 truncate" title={productTitle(c.productId)}>{productTitle(c.productId)}</TableCell>
                <TableCell className="font-medium">{c.supplierName}</TableCell>
                <TableCell><Badge variant="secondary">{CONTACT_METHOD[c.contactMethod] ?? c.contactMethod}</Badge></TableCell>
                <TableCell className="font-semibold text-emerald-700">{c.priceCny != null ? `¥${c.priceCny.toFixed(2)}` : '-'}</TableCell>
                <TableCell>{c.moq ?? '-'}</TableCell>
                <TableCell>{c.leadTime || '-'}</TableCell>
                <TableCell className="max-w-56 truncate text-slate-500" title={c.content}>{c.content}</TableCell>
                <TableCell className="text-slate-400">{fmtDate(c.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" className="text-rose-600" onClick={() => void remove(c.id)} disabled={deletingId === c.id}>
                    {deletingId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>新建供应商沟通记录</DialogTitle>
            <DialogDescription>记录报价（¥）、起订量与交货周期，用于供应商比价</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>产品 *</Label>
              <Select value={form.productId || undefined} onValueChange={(v) => setForm({ ...form, productId: v })}>
                <SelectTrigger><SelectValue placeholder="选择产品" /></SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.source.sourceTitle.slice(0, 30) || p.id.slice(0, 8)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>供应商名称 *</Label>
                <Input value={form.supplierName} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label>沟通方式</Label>
                <Select value={form.contactMethod} onValueChange={(v) => setForm({ ...form, contactMethod: v as SupplierCommunication['contactMethod'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CONTACT_METHOD).map(([k, label]) => (
                      <SelectItem key={k} value={k}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label>报价（¥）</Label>
                <Input type="number" min={0} step="0.01" value={form.priceCny} onChange={(e) => setForm({ ...form, priceCny: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label>MOQ</Label>
                <Input type="number" min={0} value={form.moq} onChange={(e) => setForm({ ...form, moq: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label>交期</Label>
                <Input value={form.leadTime} onChange={(e) => setForm({ ...form, leadTime: e.target.value })} placeholder="15 天" />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>沟通内容 *</Label>
              <Textarea rows={3} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>供应商回复</Label>
              <Textarea rows={2} value={form.response} onChange={(e) => setForm({ ...form, response: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.productId || !form.supplierName.trim() || !form.content.trim()}>
              {create.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  )
}

// ---------- 邮件草稿 Tab ----------
function EmailsTab({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [viewing, setViewing] = useState<import('@/types').EmailDraft | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [form, setForm] = useState({ customerId: '', inquiryId: 'none', subject: '', content: '' })
  const [aiForm, setAiForm] = useState({ customerId: '', inquiryId: 'none', tone: 'professional' as 'professional' | 'friendly' | 'formal' })

  const { data: customers } = useQuery({ queryKey: ['oc-customers', ''], queryFn: () => orderApi.listCustomers() })
  const customerList = customers ?? []
  const { data: inquiries } = useQuery({ queryKey: ['oc-inquiries', 'all'], queryFn: () => orderApi.listInquiries() })
  const inquiryList = inquiries ?? []

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['oc-emails'],
    queryFn: () => orderApi.listEmailDrafts(),
  })
  const drafts = data ?? []

  const openCreate = () => {
    setForm({ customerId: customerList[0]?.id ?? '', inquiryId: 'none', subject: '', content: '' })
    setDialogOpen(true)
  }
  const openAi = () => {
    setAiForm({ customerId: customerList[0]?.id ?? '', inquiryId: 'none', tone: 'professional' })
    setAiOpen(true)
  }

  const create = useMutation({
    mutationFn: () =>
      orderApi.createEmailDraft({
        customerId: form.customerId,
        inquiryId: form.inquiryId === 'none' ? undefined : form.inquiryId,
        subject: form.subject,
        content: form.content,
      }),
    onSuccess: () => {
      toast.success('邮件草稿已保存')
      setDialogOpen(false)
      void qc.invalidateQueries({ queryKey: ['oc-emails'] })
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const aiGenerate = useMutation({
    mutationFn: () =>
      orderApi.generateEmailDraft({
        customerId: aiForm.customerId,
        inquiryId: aiForm.inquiryId === 'none' ? undefined : aiForm.inquiryId,
        tone: aiForm.tone,
      }),
    onSuccess: (d) => {
      toast.success('AI 邮件草稿已生成')
      setAiOpen(false)
      void qc.invalidateQueries({ queryKey: ['oc-emails'] })
      setViewing(d)
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  })

  const markSent = async (d: import('@/types').EmailDraft) => {
    setSendingId(d.id)
    try {
      await orderApi.markEmailSent(d.id)
      toast.success('已标记为发送，关联询盘状态更新为已回复')
      void qc.invalidateQueries({ queryKey: ['oc-emails'] })
      onChanged()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSendingId(null)
    }
  }

  const remove = async (id: string) => {
    setDeletingId(id)
    try {
      await orderApi.deleteEmailDraft(id)
      toast.success('邮件草稿已删除')
      void qc.invalidateQueries({ queryKey: ['oc-emails'] })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDeletingId(null)
    }
  }

  const customerName = (id: string) => customerList.find((c) => c.id === id)?.name ?? id.slice(0, 8)

  return (
    <SectionCard
      title="邮件草稿"
      hint="手动撰写或 AI 生成回复邮件，标记发送后自动更新询盘状态"
      right={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isRefetching}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
          </Button>
          <Button variant="outline" size="sm" onClick={openAi} disabled={customerList.length === 0}>
            <Sparkles className="mr-1 h-3.5 w-3.5" /> AI 生成
          </Button>
          <Button size="sm" onClick={openCreate} disabled={customerList.length === 0}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 手写邮件
          </Button>
        </div>
      }
    >
      {customerList.length === 0 && <p className="mb-3 text-xs text-amber-600">请先在「客户管理」创建客户</p>}
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-sm text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
        </div>
      ) : drafts.length === 0 ? (
        <p className="py-12 text-center text-sm text-slate-400">暂无邮件草稿</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>主题</TableHead>
              <TableHead>客户</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>日期</TableHead>
              <TableHead className="w-40 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drafts.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="max-w-56 truncate font-medium" title={d.subject}>{d.subject}</TableCell>
                <TableCell>{customerName(d.customerId)}</TableCell>
                <TableCell>
                  {d.isAiGenerated ? (
                    <Badge variant="outline" className="border-violet-200 bg-violet-50 text-violet-700">AI 生成</Badge>
                  ) : (
                    <Badge variant="secondary">手写</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {d.status === 'sent' ? (
                    <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">已发送</Badge>
                  ) : (
                    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">草稿</Badge>
                  )}
                </TableCell>
                <TableCell className="text-slate-400">{fmtDate(d.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setViewing(d)}>查看</Button>
                    {d.status === 'draft' && (
                      <Button variant="ghost" size="sm" className="text-emerald-600" onClick={() => void markSent(d)} disabled={sendingId === d.id}>
                        {sendingId === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="text-rose-600" onClick={() => void remove(d.id)} disabled={deletingId === d.id}>
                      {deletingId === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* 手写邮件 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>手写邮件</DialogTitle>
            <DialogDescription>保存为草稿后可标记发送</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>客户 *</Label>
                <Select value={form.customerId} onValueChange={(v) => setForm({ ...form, customerId: v })}>
                  <SelectTrigger><SelectValue placeholder="选择客户" /></SelectTrigger>
                  <SelectContent>
                    {customerList.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}{c.company ? `（${c.company}）` : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>关联询盘</Label>
                <Select value={form.inquiryId} onValueChange={(v) => setForm({ ...form, inquiryId: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不关联</SelectItem>
                    {inquiryList.map((i) => (
                      <SelectItem key={i.id} value={i.id}>{i.subject.slice(0, 24)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>主题 *</Label>
              <Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>正文 *</Label>
              <Textarea rows={8} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.customerId || !form.subject.trim() || !form.content.trim()}>
              {create.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 保存草稿
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI 生成 */}
      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>AI 生成邮件草稿</DialogTitle>
            <DialogDescription>根据客户与询盘内容自动生成回复邮件（需在设置页配置 AI）</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>客户 *</Label>
              <Select value={aiForm.customerId} onValueChange={(v) => setAiForm({ ...aiForm, customerId: v })}>
                <SelectTrigger><SelectValue placeholder="选择客户" /></SelectTrigger>
                <SelectContent>
                  {customerList.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}{c.company ? `（${c.company}）` : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>关联询盘</Label>
              <Select value={aiForm.inquiryId} onValueChange={(v) => setAiForm({ ...aiForm, inquiryId: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不关联（通用回复）</SelectItem>
                  {inquiryList.map((i) => (
                    <SelectItem key={i.id} value={i.id}>{i.subject.slice(0, 24)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>语气</Label>
              <Select value={aiForm.tone} onValueChange={(v) => setAiForm({ ...aiForm, tone: v as typeof aiForm.tone })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="professional">专业（Professional）</SelectItem>
                  <SelectItem value="friendly">友好（Friendly）</SelectItem>
                  <SelectItem value="formal">正式（Formal）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAiOpen(false)}>取消</Button>
            <Button onClick={() => aiGenerate.mutate()} disabled={aiGenerate.isPending || !aiForm.customerId}>
              {aiGenerate.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
              生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 查看邮件 */}
      <Dialog open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{viewing?.subject}</DialogTitle>
            <DialogDescription>
              {viewing ? `${customerName(viewing.customerId)} · ${viewing.isAiGenerated ? 'AI 生成' : '手写'} · ${viewing.status === 'sent' ? '已发送' : '草稿'}` : ''}
            </DialogDescription>
          </DialogHeader>
          <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm leading-relaxed text-slate-800">{viewing?.content}</pre>
          <DialogFooter>
            {viewing?.status === 'draft' && (
              <Button
                onClick={() => {
                  const d = viewing
                  setViewing(null)
                  void markSent(d)
                }}
              >
                <Send className="mr-1 h-3.5 w-3.5" /> 标记为已发送
              </Button>
            )}
            <Button variant="outline" onClick={() => setViewing(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  )
}
