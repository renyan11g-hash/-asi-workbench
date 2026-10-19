import { randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { Customer, CustomerType } from '../types'

export const customersRouter: Router = Router()

const customerSchema = z.object({
  name: z.string().min(1).max(200),
  company: z.string().max(200).optional(),
  email: z.string().email(),
  phone: z.string().max(50).optional(),
  address: z.string().max(500).optional(),
  country: z.string().max(100).optional(),
  type: z.enum(['distributor', 'retailer', 'corporate', 'individual']).default('individual'),
  notes: z.string().max(1000).optional(),
})

interface CustomerRow {
  id: string
  name: string
  company: string | null
  email: string
  phone: string | null
  address: string | null
  country: string | null
  type: string
  notes: string | null
  created_at: string
  updated_at: string
}

function rowToCustomer(r: CustomerRow): Customer {
  return {
    id: r.id,
    name: r.name,
    company: r.company ?? undefined,
    email: r.email,
    phone: r.phone ?? undefined,
    address: r.address ?? undefined,
    country: r.country ?? undefined,
    type: r.type as CustomerType,
    notes: r.notes ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function findCustomer(id: string): CustomerRow | undefined {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustomerRow | undefined
}

// ---------- 客户列表 ----------
customersRouter.get('/', async (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM customers ORDER BY updated_at DESC').all() as CustomerRow[]
  res.json({ customers: rows.map(rowToCustomer) })
})

// ---------- 搜索客户 ----------
customersRouter.get('/search', async (req: Request, res: Response) => {
  const q = ((req.query.q as string) || '').trim()
  if (!q) {
    const rows = db.prepare('SELECT * FROM customers ORDER BY updated_at DESC').all() as CustomerRow[]
    res.json({ customers: rows.map(rowToCustomer) })
    return
  }

  const like = `%${q}%`
  const rows = db
    .prepare(
      'SELECT * FROM customers WHERE name LIKE ? OR company LIKE ? OR email LIKE ? ORDER BY updated_at DESC'
    )
    .all(like, like, like) as CustomerRow[]
  res.json({ customers: rows.map(rowToCustomer) })
})

// ---------- 获取单个客户 ----------
customersRouter.get('/:id', async (req: Request, res: Response) => {
  const row = findCustomer(String(req.params.id))
  if (!row) throw new AppError(404, '客户不存在')
  res.json({ customer: rowToCustomer(row) })
})

// ---------- 创建客户 ----------
customersRouter.post('/', async (req: Request, res: Response) => {
  const body = customerSchema.parse(req.body ?? {})
  const now = new Date().toISOString()
  const id = randomUUID()

  // 检查邮箱是否已存在
  const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(body.email)
  if (existing) {
    throw new AppError(409, '该邮箱已存在')
  }

  db.prepare(
    `INSERT INTO customers (id, name, company, email, phone, address, country, type, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    body.name,
    body.company ?? null,
    body.email,
    body.phone ?? null,
    body.address ?? null,
    body.country ?? null,
    body.type,
    body.notes ?? null,
    now,
    now
  )

  const row = findCustomer(id)
  res.status(201).json({ customer: row ? rowToCustomer(row) : null })
})

// ---------- 更新客户 ----------
customersRouter.put('/:id', async (req: Request, res: Response) => {
  const row = findCustomer(String(req.params.id))
  if (!row) throw new AppError(404, '客户不存在')

  const body = customerSchema.partial().parse(req.body ?? {})
  const now = new Date().toISOString()

  // 如果要更新邮箱，检查是否与其他客户冲突
  if (body.email && body.email !== row.email) {
    const existing = db.prepare('SELECT id FROM customers WHERE email = ? AND id != ?').get(
      body.email,
      row.id
    )
    if (existing) {
      throw new AppError(409, '该邮箱已被其他客户使用')
    }
  }

  const updates: string[] = []
  const params: unknown[] = []

  if (body.name !== undefined) {
    updates.push('name = ?')
    params.push(body.name)
  }
  if (body.company !== undefined) {
    updates.push('company = ?')
    params.push(body.company ?? null)
  }
  if (body.email !== undefined) {
    updates.push('email = ?')
    params.push(body.email)
  }
  if (body.phone !== undefined) {
    updates.push('phone = ?')
    params.push(body.phone ?? null)
  }
  if (body.address !== undefined) {
    updates.push('address = ?')
    params.push(body.address ?? null)
  }
  if (body.country !== undefined) {
    updates.push('country = ?')
    params.push(body.country ?? null)
  }
  if (body.type !== undefined) {
    updates.push('type = ?')
    params.push(body.type)
  }
  if (body.notes !== undefined) {
    updates.push('notes = ?')
    params.push(body.notes ?? null)
  }

  if (updates.length === 0) {
    const updated = findCustomer(row.id)
    res.json({ customer: updated ? rowToCustomer(updated) : null })
    return
  }

  updates.push('updated_at = ?')
  params.push(now)
  params.push(row.id)

  db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...params)

  const updated = findCustomer(row.id)
  res.json({ customer: updated ? rowToCustomer(updated) : null })
})

// ---------- 删除客户 ----------
customersRouter.delete('/:id', async (req: Request, res: Response) => {
  const row = findCustomer(String(req.params.id))
  if (!row) throw new AppError(404, '客户不存在')

  // 检查是否有关联的询盘或订单
  const inquiryCount = db.prepare('SELECT COUNT(*) as c FROM inquiries WHERE customer_id = ?').get(row.id) as { c: number }
  const orderCount = db.prepare('SELECT COUNT(*) as c FROM orders WHERE customer_id = ?').get(row.id) as { c: number }

  if (inquiryCount.c > 0 || orderCount.c > 0) {
    throw new AppError(400, '该客户有关联的询盘或订单，无法删除')
  }

  db.prepare('DELETE FROM customers WHERE id = ?').run(row.id)
  res.status(204).send()
})
