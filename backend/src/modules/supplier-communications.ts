import { randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { SupplierCommunication } from '../types'

export const supplierCommunicationsRouter: Router = Router()

const commSchema = z.object({
  productId: z.string(),
  supplierName: z.string().min(1).max(200),
  contactMethod: z.enum(['email', 'phone', 'wechat', 'other']).default('email'),
  content: z.string().min(1),
  response: z.string().optional(),
  priceCny: z.number().optional(),
  moq: z.number().int().optional(),
  leadTime: z.string().max(100).optional(),
})

interface CommRow {
  id: string
  product_id: string
  supplier_name: string
  contact_method: string
  content: string
  response: string | null
  price_cny: number | null
  moq: number | null
  lead_time: string | null
  created_at: string
}

function rowToComm(r: CommRow): SupplierCommunication {
  return {
    id: r.id,
    productId: r.product_id,
    supplierName: r.supplier_name,
    contactMethod: r.contact_method as 'email' | 'phone' | 'wechat' | 'other',
    content: r.content,
    response: r.response ?? undefined,
    priceCny: r.price_cny ?? undefined,
    moq: r.moq ?? undefined,
    leadTime: r.lead_time ?? undefined,
    createdAt: r.created_at,
  }
}

function findComm(id: string): CommRow | undefined {
  return db.prepare('SELECT * FROM supplier_communications WHERE id = ?').get(id) as CommRow | undefined
}

// ---------- 沟通记录列表 ----------
supplierCommunicationsRouter.get('/', async (req: Request, res: Response) => {
  const productId = (req.query.productId as string) || ''

  let sql = 'SELECT * FROM supplier_communications'
  const params: unknown[] = []

  if (productId) {
    sql += ' WHERE product_id = ?'
    params.push(productId)
  }

  sql += ' ORDER BY created_at DESC LIMIT 200'

  const rows = db.prepare(sql).all(...params) as CommRow[]
  res.json({ communications: rows.map(rowToComm) })
})

// ---------- 获取单个沟通记录 ----------
supplierCommunicationsRouter.get('/:id', async (req: Request, res: Response) => {
  const row = findComm(String(req.params.id))
  if (!row) throw new AppError(404, '沟通记录不存在')
  res.json({ communication: rowToComm(row) })
})

// ---------- 创建沟通记录 ----------
supplierCommunicationsRouter.post('/', async (req: Request, res: Response) => {
  const body = commSchema.parse(req.body ?? {})
  const now = new Date().toISOString()
  const id = randomUUID()

  // 验证产品是否存在
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(body.productId)
  if (!product) {
    throw new AppError(404, '产品不存在')
  }

  db.prepare(
    `INSERT INTO supplier_communications (id, product_id, supplier_name, contact_method, content, response, price_cny, moq, lead_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    body.productId,
    body.supplierName,
    body.contactMethod,
    body.content,
    body.response ?? null,
    body.priceCny ?? null,
    body.moq ?? null,
    body.leadTime ?? null,
    now
  )

  const row = findComm(id)
  res.status(201).json({ communication: row ? rowToComm(row) : null })
})

// ---------- 更新沟通记录 ----------
supplierCommunicationsRouter.put('/:id', async (req: Request, res: Response) => {
  const row = findComm(String(req.params.id))
  if (!row) throw new AppError(404, '沟通记录不存在')

  const body = commSchema.partial().parse(req.body ?? {})

  const updates: string[] = []
  const params: unknown[] = []

  if (body.supplierName !== undefined) {
    updates.push('supplier_name = ?')
    params.push(body.supplierName)
  }
  if (body.contactMethod !== undefined) {
    updates.push('contact_method = ?')
    params.push(body.contactMethod)
  }
  if (body.content !== undefined) {
    updates.push('content = ?')
    params.push(body.content)
  }
  if (body.response !== undefined) {
    updates.push('response = ?')
    params.push(body.response ?? null)
  }
  if (body.priceCny !== undefined) {
    updates.push('price_cny = ?')
    params.push(body.priceCny ?? null)
  }
  if (body.moq !== undefined) {
    updates.push('moq = ?')
    params.push(body.moq ?? null)
  }
  if (body.leadTime !== undefined) {
    updates.push('lead_time = ?')
    params.push(body.leadTime ?? null)
  }

  if (updates.length === 0) {
    const updated = findComm(row.id)
    res.json({ communication: updated ? rowToComm(updated) : null })
    return
  }

  params.push(row.id)

  db.prepare(`UPDATE supplier_communications SET ${updates.join(', ')} WHERE id = ?`).run(...params)

  const updated = findComm(row.id)
  res.json({ communication: updated ? rowToComm(updated) : null })
})

// ---------- 删除沟通记录 ----------
supplierCommunicationsRouter.delete('/:id', async (req: Request, res: Response) => {
  const row = findComm(String(req.params.id))
  if (!row) throw new AppError(404, '沟通记录不存在')

  db.prepare('DELETE FROM supplier_communications WHERE id = ?').run(row.id)
  res.status(204).send()
})

// ---------- 获取产品的所有沟通记录（用于报价对比） ----------
supplierCommunicationsRouter.get('/product/:productId', async (req: Request, res: Response) => {
  const productId = String(req.params.productId)

  // 验证产品是否存在
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId)
  if (!product) {
    throw new AppError(404, '产品不存在')
  }

  const rows = db
    .prepare('SELECT * FROM supplier_communications WHERE product_id = ? ORDER BY created_at DESC')
    .all(productId) as CommRow[]

  res.json({ communications: rows.map(rowToComm) })
})

// ---------- 获取产品的报价对比 ----------
supplierCommunicationsRouter.get('/product/:productId/price-comparison', async (req: Request, res: Response) => {
  const productId = String(req.params.productId)

  // 验证产品是否存在
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId)
  if (!product) {
    throw new AppError(404, '产品不存在')
  }

  const rows = db
    .prepare(
      'SELECT * FROM supplier_communications WHERE product_id = ? AND price_cny IS NOT NULL ORDER BY price_cny ASC'
    )
    .all(productId) as CommRow[]

  const comparison = rows.map((r) => ({
    supplierName: r.supplier_name,
    priceCny: r.price_cny,
    moq: r.moq,
    leadTime: r.lead_time,
    contactMethod: r.contact_method,
    createdAt: r.created_at,
  }))

  res.json({ comparison })
})
