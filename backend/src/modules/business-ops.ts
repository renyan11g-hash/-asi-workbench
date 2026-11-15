import { randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'

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
  dueAt: z.string().min(1),
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
  const overdueTasks = count("SELECT COUNT(*) AS c FROM business_tasks WHERE status = 'open' AND due_at < datetime('now')")
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
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) throw new AppError(404, '客户不存在')
  const body = z.object({
    tier: z.enum(['A','B','C']).default('C'),
    source: z.string().max(200).optional().default(''),
    preferences: z.string().max(2000).optional().default(''),
    nextFollowUpAt: z.string().nullable().optional(),
  }).parse(req.body ?? {})
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO customer_profiles (customer_id,tier,source,preferences,next_follow_up_at,updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET tier=excluded.tier,source=excluded.source,preferences=excluded.preferences,next_follow_up_at=excluded.next_follow_up_at,updated_at=excluded.updated_at`)
    .run(customerId, body.tier, body.source, body.preferences, body.nextFollowUpAt ?? null, now)
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
      f.international_shipping_usd,f.other_cost_usd,f.exchange_rate,f.commission_rate
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
    const profit = costUsd == null ? null : revenue - costUsd
    return {
      orderId:r.id, orderNumber:r.order_number, customerName:r.customer_name, status:r.status,
      paymentStatus:r.payment_status, revenueUsd:revenue, costUsd, profitUsd:profit,
      margin:profit == null || revenue <= 0 ? null : profit / revenue * 100,
      commission:profit == null ? null : profit * Number(r.commission_rate ?? 0.4),
      createdAt:r.created_at, costRecorded:complete,
    }
  })
  const complete = details.filter(d => d.costRecorded)
  const sum = (key: 'revenueUsd'|'costUsd'|'profitUsd'|'commission') => complete.reduce((n,d)=>n+Number(d[key] ?? 0),0)
  res.json({
    summary:{ orderCount:details.length, costRecordedCount:complete.length, untrackedCount:details.length-complete.length,
      revenueUsd:sum('revenueUsd'), costUsd:sum('costUsd'), profitUsd:sum('profitUsd'), commissionUsd:sum('commission') },
    details,
    note:'利润和提成只对已录入完整成本及汇率的订单计算；未录入成本的订单不会被当作零成本。',
  })
})
