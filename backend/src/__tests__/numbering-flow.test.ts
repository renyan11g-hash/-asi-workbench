import request from 'supertest'
import { createApp } from '../app'
import { env } from '../config/env'
import { db } from '../db'
import { insertProduct } from '../modules/products'
import { healPreLibrary } from '../services/library'
import type { Listing, SourceInfo } from '../types'

/**
 * 2026-11-14 线上问题回归：
 *  ① 在英文链接页保存过 = 自动审核通过、进了预产品库，编号却还是 PIP 临时号；
 *  ② 选品预估建的产品编号看起来被复用，产品“找不到了”。
 *
 * 约定（与批量流程一致）：保存只改「待审核」版本，审核通过才进预产品库并发 GLS 号；
 * PIP 号只增不减，进库后搬到 prev_code，绝不再发给别的产品。
 */

const app = createApp()

function source(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    sourceTitle: '304不锈钢保温杯 20oz',
    sourceUrl: `https://detail.1688.com/offer/${Math.random().toString(36).slice(2, 8)}.html`,
    description: '材质：304不锈钢，容量：20oz',
    sourceKeywords: [],
    amazonTitle: '',
    priceCny: 12,
    priceMaxCny: null,
    moq: 50,
    supplier: '',
    altSuppliers: '',
    materialCn: '304不锈钢',
    colorsCn: '黑色',
    sizeCn: '20oz',
    weightG: 300,
    cartonLCm: 40,
    cartonWCm: 30,
    cartonHCm: 25,
    pcsPerCarton: 60,
    cartonGwKg: 12,
    images: [],
    category: '',
    notes: '',
    ...over,
  }
}

function listingFixture(): Listing {
  return {
    title: 'Stainless Steel Insulated Tumbler',
    summary: 'Double wall tumbler for office commutes. Rush service is available',
    description: 'A durable stainless steel tumbler built for everyday commutes.',
    keywords: Array.from({ length: 30 }, (_, i) => `Group${i}`),
    category: 'Bottles-Insulated',
    categories: ['Bottles-Insulated'],
    typeOfProduct: 'Drinkware',
    themes: ['Anniversary', 'Sustainable', 'Corporate', 'Camping', 'Outdoor'],
    material: 'Stainless Steel',
    materials: ['Stainless Steel'],
    colors: 'Black',
    colorChips: ['Black'],
    imprintMethods: ['Silkscreen', 'Unimprinted', 'Full Color'],
    productSizeInch: '',
    productSizeCm: { l: 7, w: 7, h: 20 },
    unitWeightLb: 0.66,
    cartonSizeInch: '',
    cartonGwLb: 26,
    priceGrid: [],
    packaging: 'Poly bag',
    productionTime: '5-7 business days after proof approval',
    imprintArea: '',
    warnings: [],
    titleZh: '',
    summaryZh: '',
    descriptionZh: '',
    keywordsZh: '',
  }
}

function codeOf(id: string): string {
  return (db.prepare('SELECT code FROM products WHERE id = ?').get(id) as { code: string }).code
}

describe('产品编号：PIP 只增不减，进库后不再复用', () => {
  it('产品进了预产品库（PIP 号搬到 prev_code）之后，新产品的号仍要往后发', () => {
    const id1 = insertProduct({ source: source(), evaluation: null, listing: null })
    const code1 = codeOf(id1)
    expect(code1).toMatch(/^PIP\d+$/)

    // 模拟进预产品库：code 换成 GLS，旧 PIP 记到 prev_code
    db.prepare(
      "UPDATE products SET code='GLS9001', gls_code='GLS9001', prev_code=?, library_state='pre', status='listed' WHERE id=?"
    ).run(code1, id1)

    const id2 = insertProduct({ source: source(), evaluation: null, listing: null })
    const code2 = codeOf(id2)
    expect(code2).toMatch(/^PIP\d+$/)
    expect(code2).not.toBe(code1)
    expect(Number(code2.slice(3))).toBeGreaterThan(Number(code1.slice(3)))
  })
})

describe('启动自愈：已在预产品库却没发 GLS 号的产品补号', () => {
  it('PIP 号的产品只要 status=listed 就会被补上 GLS 号', () => {
    const id = insertProduct({ source: source(), evaluation: null, listing: null })
    const before = codeOf(id)
    db.prepare("UPDATE products SET status='listed', library_state='pipeline' WHERE id=?").run(id)

    healPreLibrary()

    const after = codeOf(id)
    expect(after).toMatch(/^GLS\d+$/)
    expect(after).not.toBe(before)
    const row = db.prepare('SELECT gls_code, prev_code, library_state FROM products WHERE id=?').get(id) as {
      gls_code: string
      prev_code: string
      library_state: string
    }
    expect(row.gls_code).toBe(after)
    expect(row.prev_code).toBe(before)
    expect(row.library_state).toBe('pre')
  })
})

describe('单品流程与批量流程一致：保存英文链接 ≠ 审核通过', () => {
  it('保存后仍是待审核，不会直接进预产品库', async () => {
    const id = insertProduct({ source: source(), evaluation: null, listing: null, status: 'pending_review' })
    db.prepare("UPDATE products SET review_state='pending' WHERE id=?").run(id)
    const before = codeOf(id)

    const res = await request(app)
      .patch(`${env.API_PREFIX}/products/${id}`)
      .send({ listing: listingFixture() })
      .expect(200)

    expect(res.body.product.status).toBe('pending_review')
    expect(res.body.product.reviewState).toBe('pending')
    expect(res.body.product.listing.title).toBe('Stainless Steel Insulated Tumbler')
    // 编号保持不变（PIP），等审核通过才发 GLS
    expect(codeOf(id)).toBe(before)
  })
})
