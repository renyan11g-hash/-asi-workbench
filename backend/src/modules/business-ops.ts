import { randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { callChatJson } from '../services/ai'
import { loadSettings } from './settings'

export const businessOpsRouter: Router = Router()

// Additive tables only: existing product/customer/order records are never rewritten.
db.exec(`
CREATE TABLE IF NOT EXISTS business_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT 'follow_up',
  entity_type TEXT,
  entity_id TEXT,
  due_at TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_business_tasks_due ON business_tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_business_tasks_entity ON business_tasks(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS inquiry_quotes (
  id TEXT PRIMARY KEY,
  inquiry_id TEXT NOT NULL,
  quote_number TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  quantity INTEGER NOT NULL,
  shipping_method TEXT NOT NULL DEFAULT '',
  production_time TEXT NOT NULL DEFAULT '',
  transit_time TEXT NOT NULL DEFAULT '',
  valid_until TEXT,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (inquiry_id) REFERENCES inquiries(id)
);
CREATE INDEX IF NOT EXISTS idx_inquiry_quotes_inquiry ON inquiry_quotes(inquiry_id, created_at DESC);
CREATE TABLE IF NOT EXISTS customer_profiles (
  customer_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'C',
  source TEXT NOT NULL DEFAULT '',
  preferences TEXT NOT NULL DEFAULT '',
  next_follow_up_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE TABLE IF NOT EXISTS order_financials (
  order_id TEXT PRIMARY KEY,
  product_cost_cny REAL NOT NULL DEFAULT 0,
  customization_cost_cny REAL NOT NULL DEFAULT 0,
  domestic_shipping_cny REAL NOT NULL DEFAULT 0,
  international_shipping_usd REAL NOT NULL DEFAULT 0,
  other_cost_usd REAL NOT NULL DEFAULT 0,
  exchange_rate REAL NOT NULL DEFAULT 7.2,
  commission_rate REAL NOT NULL DEFAULT 0.4,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
`)

const taskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(''),
  taskType: z.enum(['follow_up', 'quote', 'supplier', 'production', 'shipping', 'after_sales', 'other']).default('follow_up'),
  entityType: z.enum(['customer', 'inquiry', 'order', 'product', 'supplier']).optional(),
  entityId: z.string().max(100).optional(),
  dueAt: z.string().datetime(),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  status: z.enum(['open', 'done', 'cancelled']).default('open'),
})

businessOpsRouter.get('/overview', (_req: Request, res: Response) => {
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c
  const products = count("SELECT COUNT(*) AS c FROM products WHERE status != 'trashed'")
  const customers = count('SELECT COUNT(*) AS c FROM customers')
  const inquiries = count('SELECT COUNT(*) AS c FROM inquiries')
  const newInquiries = count("SELECT COUNT(*) AS c FROM inquiries WHERE status = 'new'")
  const quotedInquiries = count("SELECT COUNT(*) AS c FROM inquiries WHERE status = 'quoted'")
  const orders = count("SELECT COUNT(*) AS c FROM orders WHERE status != 'cancelled'")
  const activeOrders = count("SELECT COUNT(*) AS c FROM orders WHERE status IN ('confirmed','production','shipped')")
  const unpaidOrders = count("SELECT COUNT(*) AS c FROM orders WHERE payment_status IN ('unpaid','partial','overdue')")
  const openTasks = count("SELECT COUNT(*) AS c FROM business_tasks WHERE status = 'open'")
  const overdueTasks = count("SELECT COUNT(*) AS c FROM business_tasks WHERE status = 'open' AND julianday(due_at) < julianday('now')")
  const today = count("SELECT COUNT(*) AS c FROM business_tasks WHERE status = 'open' AND date(due_at) = date('now')")
  const untrackedOrders = count("SELECT COUNT(*) AS c FROM orders o LEFT JOIN order_financials f ON f.order_id=o.id WHERE o.status NOT IN ('cancelled') AND f.order_id IS NULL")
  res.json({ products, customers, inquiries, newInquiries, quotedInquiries, orders, activeOrders, unpaidOrders, openTasks, overdueTasks, todayTasks: today, untrackedOrders })
})

businessOpsRouter.get('/tasks', (req: Request, res: Response) => {
  const status = String(req.query.status ?? 'open')
  const rows = db.prepare(`
    SELECT * FROM business_tasks
    WHERE (? = 'all' OR status = ?)
    ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, due_at ASC
    LIMIT 300
  `).all(status, status)
  res.json({ tasks: rows })
})

businessOpsRouter.post('/tasks', (req: Request, res: Response) => {
  const body = taskSchema.parse(req.body ?? {})
  if (body.entityType && body.entityId) {
    const table = ({ customer: 'customers', inquiry: 'inquiries', order: 'orders', product: 'products' } as Record<string,string>)[body.entityType]
    if (table && !db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(body.entityId)) throw new AppError(404, '关联记录不存在')
  }
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO business_tasks (id,title,description,task_type,entity_type,entity_id,due_at,priority,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, body.title, body.description ?? '', body.taskType, body.entityType ?? null, body.entityId ?? null, body.dueAt, body.priority, body.status, now, now)
  res.status(201).json({ task: db.prepare('SELECT * FROM business_tasks WHERE id = ?').get(id) })
})

businessOpsRouter.patch('/tasks/:id', (req: Request, res: Response) => {
  const current = db.prepare('SELECT id FROM business_tasks WHERE id = ?').get(String(req.params.id))
  if (!current) throw new AppError(404, '任务不存在')
  const patch = z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    dueAt: z.string().min(1).optional(),
    priority: z.enum(['low','normal','high']).optional(),
    status: z.enum(['open','done','cancelled']).optional(),
  }).parse(req.body ?? {})
  const map: Record<string,string> = { title:'title', description:'description', dueAt:'due_at', priority:'priority', status:'status' }
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch)) { sets.push(map[key] + ' = ?'); values.push(value) }
  if (!sets.length) { res.json({ task: db.prepare('SELECT * FROM business_tasks WHERE id = ?').get(String(req.params.id)) }); return }
  sets.push('updated_at = ?'); values.push(new Date().toISOString()); values.push(String(req.params.id))
  db.prepare(`UPDATE business_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  res.json({ task: db.prepare('SELECT * FROM business_tasks WHERE id = ?').get(String(req.params.id)) })
})

businessOpsRouter.delete('/tasks/:id', (req: Request, res: Response) => {
  db.prepare('DELETE FROM business_tasks WHERE id = ?').run(String(req.params.id))
  res.status(204).send()
})

businessOpsRouter.get('/customers/:id/profile', (req: Request, res: Response) => {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(String(req.params.id))
  if (!customer) throw new AppError(404, '客户不存在')
  const profile = db.prepare('SELECT * FROM customer_profiles WHERE customer_id = ?').get(String(req.params.id))
  res.json({ profile: profile ?? { customer_id: String(req.params.id), tier: 'C', source: '', preferences: '', next_follow_up_at: null } })
})

businessOpsRouter.put('/customers/:id/profile', (req: Request, res: Response) => {
  const customerId = String(req.params.id)
  const customer = db.prepare('SELECT id,name FROM customers WHERE id = ?').get(customerId) as {id:string;name:string}|undefined
  if (!customer) throw new AppError(404, '客户不存在')
  const body = z.object({
    tier: z.enum(['A','B','C']).default('C'),
    source: z.string().max(200).optional().default(''),
    preferences: z.string().max(2000).optional().default(''),
    nextFollowUpAt: z.string().datetime().nullable().optional(),
  }).parse(req.body ?? {})
  const previous = db.prepare('SELECT next_follow_up_at FROM customer_profiles WHERE customer_id = ?').get(customerId) as {next_follow_up_at:string|null}|undefined
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO customer_profiles (customer_id,tier,source,preferences,next_follow_up_at,updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET tier=excluded.tier,source=excluded.source,preferences=excluded.preferences,next_follow_up_at=excluded.next_follow_up_at,updated_at=excluded.updated_at`)
    .run(customerId, body.tier, body.source, body.preferences, body.nextFollowUpAt ?? null, now)
  const oldTime = previous?.next_follow_up_at ? new Date(previous.next_follow_up_at).getTime() : null
  const newTime = body.nextFollowUpAt ? new Date(body.nextFollowUpAt).getTime() : null
  if (oldTime !== newTime) {
    db.prepare("UPDATE business_tasks SET status='cancelled',updated_at=? WHERE entity_type='customer' AND entity_id=? AND task_type='follow_up' AND status='open'").run(now,customerId)
    if (body.nextFollowUpAt) {
      const taskId = randomUUID()
      db.prepare(`INSERT INTO business_tasks (id,title,description,task_type,entity_type,entity_id,due_at,priority,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(taskId,'跟进客户：'+customer.name,body.preferences || '按客户档案中的偏好继续跟进','follow_up','customer',customerId,body.nextFollowUpAt,body.tier==='A'?'high':'normal','open',now,now)
    }
  }
  res.json({ profile: db.prepare('SELECT * FROM customer_profiles WHERE customer_id = ?').get(customerId) })
})

const financialSchema = z.object({
  productCostCny: z.number().min(0).default(0),
  customizationCostCny: z.number().min(0).default(0),
  domesticShippingCny: z.number().min(0).default(0),
  internationalShippingUsd: z.number().min(0).default(0),
  otherCostUsd: z.number().min(0).default(0),
  exchangeRate: z.number().positive().max(20).default(7.2),
  commissionRate: z.number().min(0).max(1).default(0.4),
  note: z.string().max(2000).optional().default(''),
})

businessOpsRouter.get('/orders/:id/financials', (req: Request, res: Response) => {
  const order = db.prepare('SELECT id,total_amount FROM orders WHERE id = ?').get(String(req.params.id)) as {id:string,total_amount:number}|undefined
  if (!order) throw new AppError(404, '订单不存在')
  const financials = db.prepare('SELECT * FROM order_financials WHERE order_id = ?').get(order.id)
  res.json({ revenueUsd: order.total_amount, financials: financials ?? null })
})

businessOpsRouter.put('/orders/:id/financials', (req: Request, res: Response) => {
  const orderId = String(req.params.id)
  if (!db.prepare('SELECT id FROM orders WHERE id = ?').get(orderId)) throw new AppError(404, '订单不存在')
  const body = financialSchema.parse(req.body ?? {})
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO order_financials (order_id,product_cost_cny,customization_cost_cny,domestic_shipping_cny,international_shipping_usd,other_cost_usd,exchange_rate,commission_rate,note,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET product_cost_cny=excluded.product_cost_cny,customization_cost_cny=excluded.customization_cost_cny,domestic_shipping_cny=excluded.domestic_shipping_cny,international_shipping_usd=excluded.international_shipping_usd,other_cost_usd=excluded.other_cost_usd,exchange_rate=excluded.exchange_rate,commission_rate=excluded.commission_rate,note=excluded.note,updated_at=excluded.updated_at`)
    .run(orderId,body.productCostCny,body.customizationCostCny,body.domesticShippingCny,body.internationalShippingUsd,body.otherCostUsd,body.exchangeRate,body.commissionRate,body.note,now)
  res.json({ financials: db.prepare('SELECT * FROM order_financials WHERE order_id = ?').get(orderId) })
})

businessOpsRouter.get('/performance', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT o.id,o.order_number,o.total_amount,o.status,o.payment_status,o.created_at,
      c.name AS customer_name, f.product_cost_cny,f.customization_cost_cny,f.domestic_shipping_cny,
      f.international_shipping_usd,f.other_cost_usd,f.exchange_rate,f.commission_rate,
      COALESCE((SELECT SUM(a.refund_amount) FROM after_sales a WHERE a.order_id=o.id),0) AS refund_usd
    FROM orders o JOIN customers c ON c.id=o.customer_id
    LEFT JOIN order_financials f ON f.order_id=o.id
    WHERE o.status != 'cancelled' ORDER BY o.created_at DESC LIMIT 300
  `).all() as Array<Record<string, any>>
  const details = rows.map((r) => {
    const complete = r.exchange_rate != null && r.exchange_rate > 0
      && r.product_cost_cny != null && r.customization_cost_cny != null && r.domestic_shipping_cny != null
      && r.international_shipping_usd != null && r.other_cost_usd != null
    const costUsd = complete
      ? (Number(r.product_cost_cny) + Number(r.customization_cost_cny) + Number(r.domestic_shipping_cny)) / Number(r.exchange_rate)
        + Number(r.international_shipping_usd) + Number(r.other_cost_usd)
      : null
    const revenue = Number(r.total_amount || 0)
    const refundUsd = Number(r.refund_usd || 0)
    const profit = costUsd == null ? null : revenue - costUsd - refundUsd
    return {
      orderId:r.id, orderNumber:r.order_number, customerName:r.customer_name, status:r.status,
      paymentStatus:r.payment_status, revenueUsd:revenue, costUsd, refundUsd, profitUsd:profit,
      margin:profit == null || revenue <= 0 ? null : profit / revenue * 100,
      commission:profit == null ? null : Math.max(0, profit) * Number(r.commission_rate ?? 0.4),
      createdAt:r.created_at, costRecorded:complete,
    }
  })
  const complete = details.filter(d => d.costRecorded)
  const sum = (key: 'revenueUsd'|'costUsd'|'refundUsd'|'profitUsd'|'commission') => complete.reduce((n,d)=>n+Number(d[key] ?? 0),0)
  res.json({
    summary:{ orderCount:details.length, costRecordedCount:complete.length, untrackedCount:details.length-complete.length,
      revenueUsd:sum('revenueUsd'), costUsd:sum('costUsd'), refundUsd:sum('refundUsd'), profitUsd:sum('profitUsd'), commissionUsd:sum('commission') },
    details,
    note:'利润和提成只对已录入完整成本及汇率的订单计算；未录入成本的订单不会被当作零成本。',
  })
})


// ---------- 订单履约：物流、收款、售后 ----------

const shipmentSchema = z.object({
  carrier: z.string().max(100).optional().default(''),
  trackingNumber: z.string().max(200).optional().default(''),
  shippingMethod: z.enum(['air','sea','express','rail','other']).default('air'),
  status: z.enum(['pending','shipped','in_transit','delivered','exception']).default('pending'),
  estimatedDelivery: z.string().nullable().optional(),
  actualDelivery: z.string().nullable().optional(),
  notes: z.string().max(2000).optional().default(''),
})

const paymentSchema = z.object({
  amount: z.number().positive(),
  paymentMethod: z.string().min(1).max(100),
  paymentDate: z.string().nullable().optional(),
  notes: z.string().max(2000).optional().default(''),
})

const afterSalesSchema = z.object({
  type: z.enum(['quality_issue','shipping_issue','shortage','wrong_item','refund','other']).default('quality_issue'),
  status: z.enum(['open','processing','resolved','closed']).default('open'),
  description: z.string().min(1).max(3000),
  resolution: z.string().max(3000).optional().default(''),
  refundAmount: z.number().min(0).optional().default(0),
})

function ensureOrder(orderId: string) {
  const row = db.prepare('SELECT id, customer_id FROM orders WHERE id = ?').get(orderId) as {id:string;customer_id:string}|undefined
  if (!row) throw new AppError(404, '订单不存在')
  return row
}

businessOpsRouter.get('/orders/:id/fulfillment', (req: Request, res: Response) => {
  const order = ensureOrder(String(req.params.id))
  const shipments = db.prepare('SELECT * FROM shipments WHERE order_id = ? ORDER BY created_at DESC').all(order.id)
  const payments = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY COALESCE(payment_date, created_at) DESC').all(order.id)
  const afterSales = db.prepare('SELECT * FROM after_sales WHERE order_id = ? ORDER BY updated_at DESC').all(order.id)
  const paymentSummary = db.prepare('SELECT COALESCE(SUM(amount),0) AS paid_amount FROM payments WHERE order_id = ?').get(order.id) as {paid_amount:number}
  res.json({ shipments, payments, afterSales, paidAmount: Number(paymentSummary.paid_amount || 0) })
})

businessOpsRouter.post('/orders/:id/shipments', (req: Request, res: Response) => {
  const order = ensureOrder(String(req.params.id))
  const body = shipmentSchema.parse(req.body ?? {})
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO shipments (id,order_id,tracking_number,carrier,shipping_method,status,estimated_delivery,actual_delivery,notes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,order.id,body.trackingNumber || null,body.carrier || null,body.shippingMethod,body.status,body.estimatedDelivery ?? null,body.actualDelivery ?? (body.status==='delivered'?now:null),body.notes,now,now)
  if (body.status === 'shipped' || body.status === 'in_transit') db.prepare("UPDATE orders SET status='shipped',updated_at=? WHERE id=?").run(now,order.id)
  if (body.status === 'delivered') db.prepare("UPDATE orders SET status='delivered',updated_at=? WHERE id=?").run(now,order.id)
  const shipment = db.prepare('SELECT * FROM shipments WHERE id = ?').get(id)
  res.status(201).json({ shipment })
})

businessOpsRouter.patch('/shipments/:id', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const current = db.prepare('SELECT id,order_id FROM shipments WHERE id = ?').get(id) as {id:string;order_id:string}|undefined
  if (!current) throw new AppError(404, '物流记录不存在')
  const body = shipmentSchema.partial().parse(req.body ?? {})
  const columns: Record<string,string> = { carrier:'carrier',trackingNumber:'tracking_number',shippingMethod:'shipping_method',status:'status',estimatedDelivery:'estimated_delivery',actualDelivery:'actual_delivery',notes:'notes' }
  const sets:string[]=[]; const values:unknown[]=[]
  for (const [key,value] of Object.entries(body)) { sets.push(columns[key]+' = ?'); values.push(value ?? null) }
  if (sets.length) {
    sets.push('updated_at = ?'); values.push(new Date().toISOString()); values.push(id)
    db.prepare(`UPDATE shipments SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }
  const now = new Date().toISOString()
  if (body.status === 'shipped' || body.status === 'in_transit') db.prepare("UPDATE orders SET status='shipped',updated_at=? WHERE id=?").run(now,current.order_id)
  if (body.status === 'delivered') {
    db.prepare("UPDATE shipments SET actual_delivery=COALESCE(actual_delivery,?) WHERE id=?").run(now,id)
    db.prepare("UPDATE orders SET status='delivered',updated_at=? WHERE id=?").run(now,current.order_id)
  }
  res.json({ shipment: db.prepare('SELECT * FROM shipments WHERE id = ?').get(id) })
})

businessOpsRouter.post('/orders/:id/payments', (req: Request, res: Response) => {
  const order = ensureOrder(String(req.params.id))
  const body = paymentSchema.parse(req.body ?? {})
  const paidBefore = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE order_id = ?').get(order.id) as {total:number}
  const orderRow = db.prepare('SELECT total_amount FROM orders WHERE id = ?').get(order.id) as {total_amount:number}
  if (Number(paidBefore.total) + body.amount > Number(orderRow.total_amount) + 0.01) throw new AppError(400, '本次收款超过订单剩余应收金额')
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO payments (id,order_id,amount,payment_method,payment_date,notes,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id,order.id,body.amount,body.paymentMethod,body.paymentDate ?? now,body.notes,now)
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE order_id = ?').get(order.id) as {total:number}
  const paymentStatus = paid.total >= orderRow.total_amount ? 'paid' : paid.total > 0 ? 'partial' : 'unpaid'
  db.prepare('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?').run(paymentStatus,now,order.id)
  res.status(201).json({ payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(id), paidAmount: Number(paid.total), paymentStatus })
})

businessOpsRouter.post('/orders/:id/after-sales', (req: Request, res: Response) => {
  const order = ensureOrder(String(req.params.id))
  const body = afterSalesSchema.parse(req.body ?? {})
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO after_sales (id,order_id,customer_id,type,status,description,resolution,refund_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id,order.id,order.customer_id,body.type,body.status,body.description,body.resolution || null,body.refundAmount ?? 0,now,now)
  res.status(201).json({ afterSale: db.prepare('SELECT * FROM after_sales WHERE id = ?').get(id) })
})

businessOpsRouter.patch('/after-sales/:id', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const current = db.prepare('SELECT id FROM after_sales WHERE id = ?').get(id)
  if (!current) throw new AppError(404, '售后记录不存在')
  const body = afterSalesSchema.partial().parse(req.body ?? {})
  const columns: Record<string,string> = { type:'type',status:'status',description:'description',resolution:'resolution',refundAmount:'refund_amount' }
  const sets:string[]=[]; const values:unknown[]=[]
  for (const [key,value] of Object.entries(body)) { sets.push(columns[key]+' = ?'); values.push(value ?? null) }
  if (sets.length) {
    sets.push('updated_at = ?'); values.push(new Date().toISOString()); values.push(id)
    db.prepare(`UPDATE after_sales SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }
  res.json({ afterSale: db.prepare('SELECT * FROM after_sales WHERE id = ?').get(id) })
})


const quoteSchema = z.object({
  quoteNumber: z.string().min(1).max(80),
  amount: z.number().positive(),
  currency: z.enum(['USD','CNY']).default('USD'),
  quantity: z.number().int().positive(),
  shippingMethod: z.string().max(100).optional().default(''),
  productionTime: z.string().max(200).optional().default(''),
  transitTime: z.string().max(200).optional().default(''),
  validUntil: z.string().nullable().optional(),
  notes: z.string().max(3000).optional().default(''),
})

businessOpsRouter.get('/inquiries/:id/quotes', (req: Request, res: Response) => {
  const inquiryId = String(req.params.id)
  if (!db.prepare('SELECT id FROM inquiries WHERE id = ?').get(inquiryId)) throw new AppError(404, '询盘不存在')
  const quotes = db.prepare('SELECT * FROM inquiry_quotes WHERE inquiry_id = ? ORDER BY created_at DESC').all(inquiryId)
  res.json({ quotes })
})

businessOpsRouter.post('/inquiries/:id/quotes', (req: Request, res: Response) => {
  const inquiryId = String(req.params.id)
  if (!db.prepare('SELECT id FROM inquiries WHERE id = ?').get(inquiryId)) throw new AppError(404, '询盘不存在')
  const body = quoteSchema.parse(req.body ?? {})
  if (db.prepare('SELECT id FROM inquiry_quotes WHERE quote_number = ?').get(body.quoteNumber)) throw new AppError(409, '报价编号已存在')
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO inquiry_quotes (id,inquiry_id,quote_number,amount,currency,quantity,shipping_method,production_time,transit_time,valid_until,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,inquiryId,body.quoteNumber,body.amount,body.currency,body.quantity,body.shippingMethod,body.productionTime,body.transitTime,body.validUntil ?? null,body.notes,'draft',now,now)
  db.prepare("UPDATE inquiries SET status='quoted',updated_at=? WHERE id=? AND status NOT IN ('converted','closed')").run(now,inquiryId)
  res.status(201).json({ quote: db.prepare('SELECT * FROM inquiry_quotes WHERE id = ?').get(id) })
})

businessOpsRouter.put('/quotes/:id', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const existing = db.prepare('SELECT id, status FROM inquiry_quotes WHERE id = ?').get(id) as { id: string; status: string } | undefined
  if (!existing) throw new AppError(404, '报价记录不存在')
  if (existing.status !== 'draft') throw new AppError(409, '只有草稿状态的报价可以编辑；已发送或已确认的报价请保留原记录并新建报价版本')
  const body = quoteSchema.parse(req.body ?? {})
  if (db.prepare('SELECT id FROM inquiry_quotes WHERE quote_number = ? AND id <> ?').get(body.quoteNumber, id)) throw new AppError(409, '报价编号已存在')
  db.prepare('UPDATE inquiry_quotes SET quote_number=?,amount=?,currency=?,quantity=?,shipping_method=?,production_time=?,transit_time=?,valid_until=?,notes=?,updated_at=? WHERE id=?')
    .run(body.quoteNumber,body.amount,body.currency,body.quantity,body.shippingMethod,body.productionTime,body.transitTime,body.validUntil ?? null,body.notes,new Date().toISOString(),id)
  res.json({ quote: db.prepare('SELECT * FROM inquiry_quotes WHERE id = ?').get(id) })
})

businessOpsRouter.patch('/quotes/:id/status', (req: Request, res: Response) => {
  const id = String(req.params.id)
  const existing = db.prepare('SELECT id,status FROM inquiry_quotes WHERE id = ?').get(id) as { id: string; status: string } | undefined
  if (!existing) throw new AppError(404, '报价记录不存在')
  const body = z.object({ status: z.enum(['draft','sent','accepted','rejected','expired']) }).parse(req.body ?? {})
  const allowedTransitions: Record<string, string[]> = {
    draft: ['draft', 'sent'],
    sent: ['sent', 'accepted', 'rejected', 'expired'],
    accepted: ['accepted'],
    rejected: ['rejected'],
    expired: ['expired'],
  }
  if (!(allowedTransitions[existing.status] ?? []).includes(body.status)) {
    throw new AppError(409, '报价状态不能回退或跳级；草稿先标记为已发送，已发送报价再记录接受、拒绝或过期')
  }
  if (body.status !== existing.status) {
    db.prepare('UPDATE inquiry_quotes SET status=?,updated_at=? WHERE id=?').run(body.status,new Date().toISOString(),id)
  }
  res.json({ quote: db.prepare('SELECT * FROM inquiry_quotes WHERE id = ?').get(id) })
})

 // ---------- 统一业务 AI 助手：只读检索真实业务数据，不直接修改记录 ----------
businessOpsRouter.post('/assistant', async (req: Request, res: Response) => {
  const body = z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().trim().min(1).max(4000),
    })).min(1).max(12),
  }).parse(req.body ?? {})
  const userMessages = body.messages.filter(m => m.role === 'user')
  const latestQuestion = userMessages[userMessages.length - 1]?.content ?? ''
  if (!latestQuestion) throw new AppError(400, '请输入要查询的问题')
  const retrievalText = userMessages.slice(-4).map(m => m.content).join(' ')

  const stopWords = new Set(['帮我','请问','请帮','一下','这个','那个','怎么','如何','哪些','什么','是否','有没有','可以','现在','目前','相关','情况','信息','资料','查询','查一下','分析','总结','看看','告诉我','最近','分别','来自','对应','然后','还有','以及','一下子','the','and','for','with','from','what','which','when','where','how','please','about','show','find','help','can','you','our','your','looking','need'])
  const rawTerms = retrievalText.match(/[\u4e00-\u9fff]{2,}|[a-z0-9][a-z0-9._-]{2,}/gi) ?? []
  const expandedTerms = rawTerms.flatMap(token => {
    const lower = token.toLowerCase()
    if (/^[\u4e00-\u9fff]+$/.test(lower)) {
      const pairs = Array.from({ length: Math.max(0, lower.length - 1) }, (_, i) => lower.slice(i, i + 2))
      const triples = lower.length > 4 ? Array.from({ length: lower.length - 2 }, (_, i) => lower.slice(i, i + 3)) : []
      return [...triples, ...pairs]
    }
    return [lower]
  })
  const terms = Array.from(new Set(expandedTerms.filter(x => x.length >= 2 && !stopWords.has(x)))).slice(-12)

  const buildWhere = (columns: string[]) => {
    if (!terms.length) return { sql: '1=1', params: [] as string[] }
    const sql = terms.map(() => '(' + columns.map(c => "COALESCE(" + c + ", '') LIKE ?").join(' OR ') + ')').join(' OR ')
    return { sql, params: terms.flatMap(term => columns.map(() => '%' + term + '%')) }
  }
  const customerWhere = buildWhere(['name','company','country','notes'])
  const inquiryWhere = buildWhere(['i.subject','i.content','c.name','c.company','p.source_title','p.gls_code'])
  const productWhere = buildWhere(['gls_code','code','source_title','source_url','supplier','platform_name','platform_product_id','platform_url','listing'])
  const orderWhere = buildWhere(['o.order_number','c.name','c.company','i.subject','p.source_title'])
  const quoteWhere = buildWhere(['q.quote_number','q.shipping_method','q.notes','i.subject','c.name','c.company'])
  const taskWhere = buildWhere(['title','description'])
  const supplierWhere = buildWhere(['sc.supplier_name','sc.content','sc.response','p.source_title','p.gls_code'])

  const customers = db.prepare("SELECT id,name,company,country,type,substr(notes,1,300) AS notes,updated_at FROM customers WHERE " + customerWhere.sql + " ORDER BY updated_at DESC LIMIT 8").all(...customerWhere.params)
  const inquiries = db.prepare("SELECT i.id,i.subject,substr(i.content,1,800) AS content,i.status,i.type,i.ai_category,i.product_id,i.created_at,i.updated_at,c.name AS customer_name,c.company AS customer_company,p.gls_code,p.source_title AS product_title FROM inquiries i JOIN customers c ON c.id=i.customer_id LEFT JOIN products p ON p.id=i.product_id WHERE " + inquiryWhere.sql + " ORDER BY i.updated_at DESC LIMIT 8").all(...inquiryWhere.params)
  const products = db.prepare("SELECT id,gls_code,code,source_title,source_url,supplier,price_cny,moq,material_cn,size_cn,weight_g,platform_name,platform_product_id,platform_url,listing,status,updated_at FROM products WHERE status != 'trashed' AND (" + productWhere.sql + ") ORDER BY updated_at DESC LIMIT 10").all(...productWhere.params) as Array<Record<string, any>>
  const orders = db.prepare("SELECT o.id,o.order_number,o.status,o.payment_status,o.total_amount,o.created_at,o.updated_at,c.name AS customer_name,c.company AS customer_company,i.id AS inquiry_id,i.subject AS inquiry_subject FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN inquiries i ON i.id=o.inquiry_id LEFT JOIN order_items oi ON oi.order_id=o.id LEFT JOIN products p ON p.id=oi.product_id WHERE " + orderWhere.sql + " GROUP BY o.id ORDER BY o.updated_at DESC LIMIT 8").all(...orderWhere.params)
  const quotes = db.prepare("SELECT q.id,q.inquiry_id,q.quote_number,q.amount,q.currency,q.quantity,q.shipping_method,q.production_time,q.transit_time,q.valid_until,substr(q.notes,1,300) AS notes,q.status,q.created_at,i.subject AS inquiry_subject,c.name AS customer_name FROM inquiry_quotes q JOIN inquiries i ON i.id=q.inquiry_id JOIN customers c ON c.id=i.customer_id WHERE " + quoteWhere.sql + " ORDER BY q.updated_at DESC LIMIT 10").all(...quoteWhere.params)
  const supplierCommunications = db.prepare("SELECT sc.id,sc.product_id,sc.supplier_name,substr(sc.content,1,500) AS content,substr(sc.response,1,500) AS response,sc.price_cny,sc.moq,sc.lead_time,sc.created_at,p.gls_code,p.source_title AS product_title FROM supplier_communications sc LEFT JOIN products p ON p.id=sc.product_id WHERE " + supplierWhere.sql + " ORDER BY sc.created_at DESC LIMIT 8").all(...supplierWhere.params)
  const tasks = db.prepare("SELECT id,title,description,task_type,entity_type,entity_id,due_at,priority,status FROM business_tasks WHERE status='open' AND (" + taskWhere.sql + ") ORDER BY due_at ASC LIMIT 8").all(...taskWhere.params)
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c
  const counts = {
    products: count("SELECT COUNT(*) AS c FROM products WHERE status != 'trashed'"),
    customers: count('SELECT COUNT(*) AS c FROM customers'),
    inquiries: count('SELECT COUNT(*) AS c FROM inquiries'),
    orders: count('SELECT COUNT(*) AS c FROM orders'),
    quotes: count('SELECT COUNT(*) AS c FROM inquiry_quotes'),
  }
  const context = {
    counts, searchTerms: terms, customers, inquiries,
    products: products.map(p => {
      let listing: Record<string, any> | null = null
      try { listing = p.listing ? JSON.parse(String(p.listing)) : null } catch { listing = null }
      return { ...p, listing: listing ? { title: listing.title, summary: listing.summary, description: String(listing.description ?? '').slice(0, 400), keywords: (listing.keywords ?? []).slice(0, 12), category: listing.category } : null }
    }),
    orders, quotes, supplierCommunications, openTasks: tasks,
  }
  const allowedEntities = [
    ...(customers as Array<any>).map(x => ({ type: 'customer', id: x.id })),
    ...(inquiries as Array<any>).map(x => ({ type: 'inquiry', id: x.id })),
    ...products.map(x => ({ type: 'product', id: x.id })),
    ...(orders as Array<any>).map(x => ({ type: 'order', id: x.id })),
    ...(quotes as Array<any>).map(x => ({ type: 'quote', id: x.id })),
  ]
  const system = [
    '你是中国采购型 ASI Supplier 的内部业务助理，服务美国 Promotional Products Distributor。',
    '你会收到从 Workbench 数据库检索出的客户、产品、询盘、报价、订单、供应商沟通和待办数据。',
    '只能把 context 中明确存在的内容当作事实；没有记录就明确说“当前系统未查到/资料未录入”，不得猜测价格、库存、交期、认证、运输成本、客户意向或订单状态。',
    '先直接回答用户问题，再列出关键依据和需要人工确认的缺口。金额必须保留原币种；日期按数据原样表达。',
    '如果多个记录名称相似，指出歧义，不要擅自认定为同一客户或同一产品。',
    '你是只读助手：不得声称已创建、修改、删除、发送邮件、联系供应商或更改状态；可给出建议和可复制草稿，但所有操作必须由用户在对应页面人工确认。',
    '从 suppliedEntities 中挑选真正支撑回答的记录，返回对应 type 和 id，不得创造 ID。最多 8 条。',
    '只返回严格 JSON：{"reply":"中文回答","entities":[{"type":"product|customer|inquiry|order|quote","id":"已有ID"}],"missingInfo":["需要人工补充的信息"]}。'
  ].join('\n')
  const user = JSON.stringify({ conversation: body.messages, context, suppliedEntities: allowedEntities })
  const raw = await callChatJson<Record<string, unknown>>(loadSettings(), system, user, 0.2, undefined, { task: 'business-assistant' })
  const allowed = new Set(allowedEntities.map(x => x.type + ':' + x.id))
  const entities = Array.isArray(raw.entities) ? raw.entities.flatMap((item: any) => {
    if (!item || typeof item !== 'object') return []
    const type = String(item.type ?? '')
    const id = String(item.id ?? '')
    return allowed.has(type + ':' + id) ? [{ type, id }] : []
  }).slice(0, 8) : []
  const missingInfo = Array.isArray(raw.missingInfo) ? raw.missingInfo.map(String).slice(0, 8) : []
  res.json({ reply: String(raw.reply ?? '').trim() || '暂时无法生成回答，请换一种问法。', entities, missingInfo, counts })
})
