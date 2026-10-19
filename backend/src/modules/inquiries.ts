import { randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { Inquiry, InquiryStatus, InquiryType } from '../types'

export const inquiriesRouter: Router = Router()

const inquirySchema = z.object({
  customerId: z.string(),
  subject: z.string().min(1).max(500),
  content: z.string().min(1),
  type: z.enum(['price_inquiry', 'custom_quote', 'sample_request', 'general_question']).default('price_inquiry'),
  productId: z.string().optional(),
})

interface InquiryRow {
  id: string
  customer_id: string
  subject: string
  content: string
  type: string
  status: string
  product_id: string | null
  ai_category: string | null
  ai_draft: string | null
  created_at: string
  updated_at: string
}

function rowToInquiry(r: InquiryRow): Inquiry {
  return {
    id: r.id,
    customerId: r.customer_id,
    subject: r.subject,
    content: r.content,
    type: r.type as InquiryType,
    status: r.status as InquiryStatus,
    productId: r.product_id ?? undefined,
    aiCategory: r.ai_category ?? undefined,
    aiDraft: r.ai_draft ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function findInquiry(id: string): InquiryRow | undefined {
  return db.prepare('SELECT * FROM inquiries WHERE id = ?').get(id) as InquiryRow | undefined
}

// ---------- 询盘列表 ----------
inquiriesRouter.get('/', async (req: Request, res: Response) => {
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

  let sql = 'SELECT * FROM inquiries'
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`
  sql += ' ORDER BY updated_at DESC LIMIT 200'

  const rows = db.prepare(sql).all(...params) as InquiryRow[]
  res.json({ inquiries: rows.map(rowToInquiry) })
})

// ---------- 获取单个询盘 ----------
inquiriesRouter.get('/:id', async (req: Request, res: Response) => {
  const row = findInquiry(String(req.params.id))
  if (!row) throw new AppError(404, '询盘不存在')
  res.json({ inquiry: rowToInquiry(row) })
})

// ---------- 创建询盘 ----------
inquiriesRouter.post('/', async (req: Request, res: Response) => {
  const body = inquirySchema.parse(req.body ?? {})
  const now = new Date().toISOString()
  const id = randomUUID()

  // 验证客户是否存在
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(body.customerId)
  if (!customer) {
    throw new AppError(404, '客户不存在')
  }

  // 如果指定了产品，验证产品是否存在
  if (body.productId) {
    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(body.productId)
    if (!product) {
      throw new AppError(404, '产品不存在')
    }
  }

  db.prepare(
    `INSERT INTO inquiries (id, customer_id, subject, content, type, status, product_id, ai_category, ai_draft, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    body.customerId,
    body.subject,
    body.content,
    body.type,
    'new',
    body.productId ?? null,
    null,
    null,
    now,
    now
  )

  const row = findInquiry(id)
  res.status(201).json({ inquiry: row ? rowToInquiry(row) : null })
})

// ---------- 更新询盘 ----------
inquiriesRouter.put('/:id', async (req: Request, res: Response) => {
  const row = findInquiry(String(req.params.id))
  if (!row) throw new AppError(404, '询盘不存在')

  const body = inquirySchema.partial().parse(req.body ?? {})
  const now = new Date().toISOString()

  const updates: string[] = []
  const params: unknown[] = []

  if (body.subject !== undefined) {
    updates.push('subject = ?')
    params.push(body.subject)
  }
  if (body.content !== undefined) {
    updates.push('content = ?')
    params.push(body.content)
  }
  if (body.type !== undefined) {
    updates.push('type = ?')
    params.push(body.type)
  }
  if (body.productId !== undefined) {
    if (body.productId) {
      const product = db.prepare('SELECT id FROM products WHERE id = ?').get(body.productId)
      if (!product) {
        throw new AppError(404, '产品不存在')
      }
    }
    updates.push('product_id = ?')
    params.push(body.productId ?? null)
  }

  if (updates.length === 0) {
    const updated = findInquiry(row.id)
    res.json({ inquiry: updated ? rowToInquiry(updated) : null })
    return
  }

  updates.push('updated_at = ?')
  params.push(now)
  params.push(row.id)

  db.prepare(`UPDATE inquiries SET ${updates.join(', ')} WHERE id = ?`).run(...params)

  const updated = findInquiry(row.id)
  res.json({ inquiry: updated ? rowToInquiry(updated) : null })
})

// ---------- 更新询盘状态 ----------
inquiriesRouter.patch('/:id/status', async (req: Request, res: Response) => {
  const row = findInquiry(String(req.params.id))
  if (!row) throw new AppError(404, '询盘不存在')

  const { status } = z
    .object({
      status: z.enum(['new', 'responded', 'quoted', 'converted', 'closed']),
    })
    .parse(req.body ?? {})

  const now = new Date().toISOString()
  db.prepare('UPDATE inquiries SET status = ?, updated_at = ? WHERE id = ?').run(status, now, row.id)

  const updated = findInquiry(row.id)
  res.json({ inquiry: updated ? rowToInquiry(updated) : null })
})

// ---------- 删除询盘 ----------
inquiriesRouter.delete('/:id', async (req: Request, res: Response) => {
  const row = findInquiry(String(req.params.id))
  if (!row) throw new AppError(404, '询盘不存在')

  // 关联产品已有订单时禁止删除（询盘与订单通过产品间接关联）
  if (row.product_id) {
    const orderCount = db
      .prepare(
        'SELECT COUNT(*) as c FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE product_id = ?)'
      )
      .get(row.product_id) as { c: number } | undefined

    if (orderCount && orderCount.c > 0) {
      throw new AppError(400, '该询盘关联的产品已有订单，无法删除')
    }
  }

  db.prepare('DELETE FROM inquiries WHERE id = ?').run(row.id)
  res.status(204).send()
})

// ---------- AI分类询盘 ----------
inquiriesRouter.post('/:id/ai-categorize', async (req: Request, res: Response) => {
  const row = findInquiry(String(req.params.id))
  if (!row) throw new AppError(404, '询盘不存在')

  // 基于关键词的简单分类（后续可接入 AI）
  const content = row.content.toLowerCase()
  let category = 'general'

  if (content.includes('price') || content.includes('cost') || content.includes('quote')) {
    category = 'pricing'
  } else if (content.includes('sample')) {
    category = 'sample'
  } else if (content.includes('custom') || content.includes('logo') || content.includes('imprint')) {
    category = 'customization'
  } else if (content.includes('shipping') || content.includes('delivery')) {
    category = 'logistics'
  }

  const now = new Date().toISOString()
  db.prepare('UPDATE inquiries SET ai_category = ?, updated_at = ? WHERE id = ?').run(
    category,
    now,
    row.id
  )

  const updated = findInquiry(row.id)
  res.json({ inquiry: updated ? rowToInquiry(updated) : null })
})
