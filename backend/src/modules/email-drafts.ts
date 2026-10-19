import { randomUUID } from 'crypto'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../db'
import { AppError } from '../middleware/errorHandler'
import { EmailDraft } from '../types'
import { loadSettings } from './settings'
import { callChatJson } from '../services/ai'

export const emailDraftsRouter: Router = Router()

const emailDraftSchema = z.object({
  inquiryId: z.string().optional(),
  customerId: z.string(),
  subject: z.string().min(1).max(500),
  content: z.string().min(1),
  isAiGenerated: z.boolean().default(false),
  status: z.enum(['draft', 'sent']).default('draft'),
})

interface EmailDraftRow {
  id: string
  inquiry_id: string | null
  customer_id: string
  subject: string
  content: string
  is_ai_generated: number
  status: string
  created_at: string
  updated_at: string
}

function rowToEmailDraft(r: EmailDraftRow): EmailDraft {
  return {
    id: r.id,
    inquiryId: r.inquiry_id ?? undefined,
    customerId: r.customer_id,
    subject: r.subject,
    content: r.content,
    isAiGenerated: r.is_ai_generated === 1,
    status: r.status as 'draft' | 'sent',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function findEmailDraft(id: string): EmailDraftRow | undefined {
  return db.prepare('SELECT * FROM email_drafts WHERE id = ?').get(id) as EmailDraftRow | undefined
}

// ---------- 邮件草稿列表 ----------
emailDraftsRouter.get('/', async (req: Request, res: Response) => {
  const customerId = (req.query.customerId as string) || ''
  const inquiryId = (req.query.inquiryId as string) || ''
  const status = (req.query.status as string) || ''

  const where: string[] = []
  const params: unknown[] = []

  if (customerId) {
    where.push('customer_id = ?')
    params.push(customerId)
  }
  if (inquiryId) {
    where.push('inquiry_id = ?')
    params.push(inquiryId)
  }
  if (status) {
    where.push('status = ?')
    params.push(status)
  }

  let sql = 'SELECT * FROM email_drafts'
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`
  sql += ' ORDER BY updated_at DESC LIMIT 200'

  const rows = db.prepare(sql).all(...params) as EmailDraftRow[]
  res.json({ emailDrafts: rows.map(rowToEmailDraft) })
})

// ---------- 获取单个邮件草稿 ----------
emailDraftsRouter.get('/:id', async (req: Request, res: Response) => {
  const row = findEmailDraft(String(req.params.id))
  if (!row) throw new AppError(404, '邮件草稿不存在')
  res.json({ emailDraft: rowToEmailDraft(row) })
})

// ---------- 创建邮件草稿 ----------
emailDraftsRouter.post('/', async (req: Request, res: Response) => {
  const body = emailDraftSchema.parse(req.body ?? {})
  const now = new Date().toISOString()
  const id = randomUUID()

  // 验证客户是否存在
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(body.customerId)
  if (!customer) {
    throw new AppError(404, '客户不存在')
  }

  // 如果指定了询盘，验证询盘是否存在
  if (body.inquiryId) {
    const inquiry = db.prepare('SELECT id FROM inquiries WHERE id = ?').get(body.inquiryId)
    if (!inquiry) {
      throw new AppError(404, '询盘不存在')
    }
  }

  db.prepare(
    `INSERT INTO email_drafts (id, inquiry_id, customer_id, subject, content, is_ai_generated, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    body.inquiryId ?? null,
    body.customerId,
    body.subject,
    body.content,
    body.isAiGenerated ? 1 : 0,
    body.status,
    now,
    now
  )

  const row = findEmailDraft(id)
  res.status(201).json({ emailDraft: row ? rowToEmailDraft(row) : null })
})

// ---------- 更新邮件草稿 ----------
emailDraftsRouter.put('/:id', async (req: Request, res: Response) => {
  const row = findEmailDraft(String(req.params.id))
  if (!row) throw new AppError(404, '邮件草稿不存在')

  const body = emailDraftSchema.partial().parse(req.body ?? {})
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
  if (body.status !== undefined) {
    updates.push('status = ?')
    params.push(body.status)
  }

  if (updates.length === 0) {
    const updated = findEmailDraft(row.id)
    res.json({ emailDraft: updated ? rowToEmailDraft(updated) : null })
    return
  }

  updates.push('updated_at = ?')
  params.push(now)
  params.push(row.id)

  db.prepare(`UPDATE email_drafts SET ${updates.join(', ')} WHERE id = ?`).run(...params)

  const updated = findEmailDraft(row.id)
  res.json({ emailDraft: updated ? rowToEmailDraft(updated) : null })
})

// ---------- 删除邮件草稿 ----------
emailDraftsRouter.delete('/:id', async (req: Request, res: Response) => {
  const row = findEmailDraft(String(req.params.id))
  if (!row) throw new AppError(404, '邮件草稿不存在')

  db.prepare('DELETE FROM email_drafts WHERE id = ?').run(row.id)
  res.status(204).send()
})

// ---------- AI生成邮件草稿 ----------
emailDraftsRouter.post('/ai-generate', async (req: Request, res: Response) => {
  const { inquiryId, customerId, tone } = z
    .object({
      inquiryId: z.string().optional(),
      customerId: z.string(),
      tone: z.enum(['professional', 'friendly', 'formal']).default('professional'),
    })
    .parse(req.body ?? {})

  // 验证客户是否存在
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as {
    name: string
    company: string | null
    email: string
  } | null
  if (!customer) {
    throw new AppError(404, '客户不存在')
  }

  let inquiryContent = ''
  let inquirySubject = ''
  let productInfo = ''

  // 如果指定了询盘，获取询盘内容和关联产品信息
  if (inquiryId) {
    const inquiry = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(inquiryId) as {
      subject: string
      content: string
      product_id: string | null
    } | null
    if (!inquiry) {
      throw new AppError(404, '询盘不存在')
    }

    inquirySubject = inquiry.subject
    inquiryContent = inquiry.content

    // 获取产品信息
    if (inquiry.product_id) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(inquiry.product_id) as {
        source_title: string
        listing: string | null
      } | null
      if (product && product.listing) {
        try {
          const listing = JSON.parse(product.listing) as { title: string; summary: string }
          productInfo = `Product: ${listing.title}\n${listing.summary}`
        } catch {
          productInfo = `Product: ${product.source_title}`
        }
      }
    }
  }

  // 构建AI提示词
  const systemPrompt = `You are a professional sales representative for an ASI promotional products distributor. Write email responses in a ${tone} tone. The response should be:
- Clear and concise
- Address the customer's inquiry
- Include relevant product information if available
- Include a call to action
- Professional and polite`

  const userPrompt = `Customer: ${customer.name}${customer.company ? ` from ${customer.company}` : ''}

Original Inquiry:
Subject: ${inquirySubject || 'General inquiry'}
Content: ${inquiryContent || 'No specific inquiry provided'}

${productInfo ? `\nProduct Information:\n${productInfo}` : ''}

Please write a professional email response to this customer. The response should include:
1. A greeting addressing the customer by name
2. Acknowledgment of their inquiry
3. Relevant information or answer to their question
4. A call to action (e.g., request for more details, offer to send samples, etc.)
5. A professional closing

Provide the response in the following JSON format:
{
  "subject": "Email subject line",
  "content": "Full email body"
}`

  try {
    const settings = loadSettings()
    const result = await callChatJson<{ subject: string; content: string }>(
      settings,
      systemPrompt,
      userPrompt,
      0.7
    )

    const now = new Date().toISOString()
    const id = randomUUID()

    // 保存AI生成的草稿
    db.prepare(
      `INSERT INTO email_drafts (id, inquiry_id, customer_id, subject, content, is_ai_generated, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      inquiryId ?? null,
      customerId,
      result.subject,
      result.content,
      1,
      'draft',
      now,
      now
    )

    const row = findEmailDraft(id)
    res.status(201).json({ emailDraft: row ? rowToEmailDraft(row) : null })
  } catch {
    throw new AppError(502, 'AI生成邮件草稿失败，请检查AI配置')
  }
})

// ---------- 标记邮件为已发送 ----------
emailDraftsRouter.patch('/:id/send', async (req: Request, res: Response) => {
  const row = findEmailDraft(String(req.params.id))
  if (!row) throw new AppError(404, '邮件草稿不存在')

  const now = new Date().toISOString()
  db.prepare('UPDATE email_drafts SET status = ?, updated_at = ? WHERE id = ?').run('sent', now, row.id)

  // 如果关联了询盘，更新询盘状态为已回复
  if (row.inquiry_id) {
    db.prepare('UPDATE inquiries SET status = ?, updated_at = ? WHERE id = ?').run(
      'responded',
      now,
      row.inquiry_id
    )
  }

  const updated = findEmailDraft(row.id)
  res.json({ emailDraft: updated ? rowToEmailDraft(updated) : null })
})
