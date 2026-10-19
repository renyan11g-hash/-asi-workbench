import { randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { Order, OrderStatus, PaymentStatus, OrderItem } from '../types'

export const ordersRouter: Router = Router()

const orderSchema = z.object({
  customerId: z.string(),
  orderNumber: z.string().min(1).max(50),
  status: z.enum(['pending', 'confirmed', 'production', 'shipped', 'delivered', 'cancelled']).default('pending'),
  paymentStatus: z.enum(['unpaid', 'partial', 'paid', 'overdue']).default('unpaid'),
  totalAmount: z.number().positive(),
  depositAmount: z.number().optional(),
  balanceAmount: z.number().optional(),
  notes: z.string().max(1000).optional(),
})

const orderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().positive(),
  imprintSpec: z.string().max(500).optional(),
})

interface OrderRow {
  id: string
  customer_id: string
  order_number: string
  status: string
  payment_status: string
  total_amount: number
  deposit_amount: number | null
  balance_amount: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

interface OrderItemRow {
  id: string
  order_id: string
  product_id: string
  quantity: number
  unit_price: number
  total_price: number
  imprint_spec: string | null
  created_at: string
}

function rowToOrder(r: OrderRow): Order {
  return {
    id: r.id,
    customerId: r.customer_id,
    orderNumber: r.order_number,
    status: r.status as OrderStatus,
    paymentStatus: r.payment_status as PaymentStatus,
    totalAmount: r.total_amount,
    depositAmount: r.deposit_amount ?? undefined,
    balanceAmount: r.balance_amount ?? undefined,
    notes: r.notes ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToOrderItem(r: OrderItemRow): OrderItem {
  return {
    id: r.id,
    orderId: r.order_id,
    productId: r.product_id,
    quantity: r.quantity,
    unitPrice: r.unit_price,
    totalPrice: r.total_price,
    imprintSpec: r.imprint_spec ?? undefined,
    createdAt: r.created_at,
  }
}

function findOrder(id: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined
}

// ---------- 订单列表 ----------
ordersRouter.get('/', async (req: Request, res: Response) => {
  const status = (req.query.status as string) || ''
  const customerId = (req.query.customerId as string) || ''

  const where: string[] = []
  const params: unknown[] = []

  if (status) {
    where.push('status = ?')
    params.push(status)
  }
  if (customerId) {
    where.push('customer_id = ?')
    params.push(customerId)
  }

  let sql = 'SELECT * FROM orders'
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`
  sql += ' ORDER BY updated_at DESC LIMIT 200'

  const rows = db.prepare(sql).all(...params) as OrderRow[]
  res.json({ orders: rows.map(rowToOrder) })
})

// ---------- 获取单个订单（含明细） ----------
ordersRouter.get('/:id', async (req: Request, res: Response) => {
  const row = findOrder(String(req.params.id))
  if (!row) throw new AppError(404, '订单不存在')

  const itemRows = db
    .prepare('SELECT * FROM order_items WHERE order_id = ?')
    .all(row.id) as OrderItemRow[]

  res.json({
    order: rowToOrder(row),
    items: itemRows.map(rowToOrderItem),
  })
})

// ---------- 创建订单 ----------
ordersRouter.post('/', async (req: Request, res: Response) => {
  const body = orderSchema.parse(req.body ?? {})
  const items = z.array(orderItemSchema).parse(req.body.items ?? [])

  if (items.length === 0) {
    throw new AppError(400, '订单必须包含至少一个产品')
  }

  const now = new Date().toISOString()
  const id = randomUUID()

  // 验证客户是否存在
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(body.customerId)
  if (!customer) {
    throw new AppError(404, '客户不存在')
  }

  // 验证订单号是否已存在
  const existingOrder = db.prepare('SELECT id FROM orders WHERE order_number = ?').get(body.orderNumber)
  if (existingOrder) {
    throw new AppError(409, '订单号已存在')
  }

  // 验证所有产品是否存在
  for (const item of items) {
    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(item.productId)
    if (!product) {
      throw new AppError(404, `产品 ${item.productId} 不存在`)
    }
  }

  // 计算订单总金额（如果未提供）
  const calculatedTotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  const totalAmount = body.totalAmount || calculatedTotal

  // 创建订单
  db.prepare(
    `INSERT INTO orders (id, customer_id, order_number, status, payment_status, total_amount, deposit_amount, balance_amount, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    body.customerId,
    body.orderNumber,
    body.status,
    body.paymentStatus,
    totalAmount,
    body.depositAmount ?? null,
    body.balanceAmount ?? null,
    body.notes ?? null,
    now,
    now
  )

  // 创建订单明细
  for (const item of items) {
    const itemId = randomUUID()
    const totalPrice = item.quantity * item.unitPrice
    db.prepare(
      `INSERT INTO order_items (id, order_id, product_id, quantity, unit_price, total_price, imprint_spec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(itemId, id, item.productId, item.quantity, item.unitPrice, totalPrice, item.imprintSpec ?? null, now)
  }

  const row = findOrder(id)
  const itemRows = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id) as OrderItemRow[]

  res.status(201).json({
    order: row ? rowToOrder(row) : null,
    items: itemRows.map(rowToOrderItem),
  })
})

// ---------- 更新订单 ----------
ordersRouter.put('/:id', async (req: Request, res: Response) => {
  const row = findOrder(String(req.params.id))
  if (!row) throw new AppError(404, '订单不存在')

  const body = orderSchema.partial().parse(req.body ?? {})
  const now = new Date().toISOString()

  const updates: string[] = []
  const params: unknown[] = []

  if (body.status !== undefined) {
    updates.push('status = ?')
    params.push(body.status)
  }
  if (body.paymentStatus !== undefined) {
    updates.push('payment_status = ?')
    params.push(body.paymentStatus)
  }
  if (body.totalAmount !== undefined) {
    updates.push('total_amount = ?')
    params.push(body.totalAmount)
  }
  if (body.depositAmount !== undefined) {
    updates.push('deposit_amount = ?')
    params.push(body.depositAmount ?? null)
  }
  if (body.balanceAmount !== undefined) {
    updates.push('balance_amount = ?')
    params.push(body.balanceAmount ?? null)
  }
  if (body.notes !== undefined) {
    updates.push('notes = ?')
    params.push(body.notes ?? null)
  }

  if (updates.length === 0) {
    const updated = findOrder(row.id)
    const itemRows = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(row.id) as OrderItemRow[]
    res.json({
      order: updated ? rowToOrder(updated) : null,
      items: itemRows.map(rowToOrderItem),
    })
    return
  }

  updates.push('updated_at = ?')
  params.push(now)
  params.push(row.id)

  db.prepare(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`).run(...params)

  const updated = findOrder(row.id)
  const itemRows = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(row.id) as OrderItemRow[]

  res.json({
    order: updated ? rowToOrder(updated) : null,
    items: itemRows.map(rowToOrderItem),
  })
})

// ---------- 删除订单 ----------
ordersRouter.delete('/:id', async (req: Request, res: Response) => {
  const row = findOrder(String(req.params.id))
  if (!row) throw new AppError(404, '订单不存在')

  // 只能删除未确认的订单
  if (row.status !== 'pending') {
    throw new AppError(400, '只能删除未确认的订单')
  }

  // 删除订单明细
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(row.id)

  // 删除订单
  db.prepare('DELETE FROM orders WHERE id = ?').run(row.id)

  res.status(204).send()
})

// ---------- 更新订单状态 ----------
ordersRouter.patch('/:id/status', async (req: Request, res: Response) => {
  const row = findOrder(String(req.params.id))
  if (!row) throw new AppError(404, '订单不存在')

  const { status } = z
    .object({
      status: z.enum(['pending', 'confirmed', 'production', 'shipped', 'delivered', 'cancelled']),
    })
    .parse(req.body ?? {})

  const now = new Date().toISOString()
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, now, row.id)

  const updated = findOrder(row.id)
  res.json({ order: updated ? rowToOrder(updated) : null })
})

// ---------- 更新付款状态 ----------
ordersRouter.patch('/:id/payment-status', async (req: Request, res: Response) => {
  const row = findOrder(String(req.params.id))
  if (!row) throw new AppError(404, '订单不存在')

  const { paymentStatus } = z
    .object({
      paymentStatus: z.enum(['unpaid', 'partial', 'paid', 'overdue']),
    })
    .parse(req.body ?? {})

  const now = new Date().toISOString()
  db.prepare('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?').run(
    paymentStatus,
    now,
    row.id
  )

  const updated = findOrder(row.id)
  res.json({ order: updated ? rowToOrder(updated) : null })
})
