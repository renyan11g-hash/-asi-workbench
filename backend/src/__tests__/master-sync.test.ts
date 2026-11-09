/**
 * 资料库 → 全链路同步测试。
 *
 * 规则：资料库是主数据，改了之后不管信息存在哪个区块（产品档案 / 英文链接 / 待审核
 * / 已通过审核记录 / 结构化资料 / 评估库草稿），都必须跟着改。
 */

import { db } from '../db'
import { syncMasterToProducts, type MasterProduct } from '../modules/master-products'

const NOW = new Date().toISOString()
const PID = 'sync-test-product-1'
const MID = 'sync-test-master-1'
const DRAFT_ID = 'sync-test-draft-1'

function seed() {
  db.prepare('DELETE FROM products WHERE id = ?').run(PID)
  db.prepare('DELETE FROM product_specs WHERE product_id = ?').run(PID)
  db.prepare('DELETE FROM listing_reviews WHERE product_id = ?').run(PID)
  db.prepare('DELETE FROM drafts WHERE id = ?').run(DRAFT_ID)
  db.prepare('DELETE FROM product_visual_profiles WHERE product_id = ?').run(PID)
  db.prepare(
    `INSERT INTO product_visual_profiles (product_id, data, style_id, style_reason, ref_ids, model, created_at, updated_at)
     VALUES (?, '{}', NULL, '旧识别', '[]', '', ?, ?)`
  ).run(PID, NOW, NOW)

  db.prepare(
    `INSERT INTO products
      (id, master_id, draft_id, source_title, source_url, description, notes, images,
       price_cny, size_cn, weight_g, carton_l_cm, carton_w_cm, carton_h_cm, pcs_per_carton, carton_gw_kg,
       material_cn, colors_cn, supplier, category, evaluation, listing, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)`
  ).run(
    PID,
    MID,
    DRAFT_ID,
    '旧标题',
    'https://detail.1688.com/offer/1.html',
    '旧描述',
    '旧备注',
    JSON.stringify(['https://old.example/1.jpg']),
    8,
    '10x5cm',
    48,
    30,
    20,
    15,
    100,
    8,
    '铝合金',
    '黑色',
    '旧供应商',
    '办公',
    JSON.stringify({ score: 70, verdict: 'MAYBE' }),
    JSON.stringify({
      title: 'Old English Title',
      summary: 'Old summary',
      description: 'Old description',
      material: 'Aluminum',
      materials: ['Aluminum'],
      colors: 'Black',
      colorChips: ['Black'],
      productSizeInch: '3.94" W x 1.97" H',
      productSizeCm: { l: 10, w: 5, h: 5 },
      unitWeightLb: 0.11,
      cartonSizeInch: '11.81" L x 7.87" W x 5.91" H',
      cartonGwLb: 17.64,
      packaging: 'Individual poly bag; 100 pcs per carton, 30 x 20 x 15 cm, 8 kg per carton.',
      warnings: [],
      priceGrid: [
        { qty: 100, shipping: 'air', billableKg: 8, unitCostCny: 12, markupRate: 1.4, unitPrice: 2.4, margin: 10 },
      ],
    }),
    NOW,
    NOW
  )

  db.prepare(
    `INSERT INTO product_specs (product_id, data, unknown_fields, source_hash, model, created_at, updated_at)
     VALUES (?, ?, '[]', '', '', ?, ?)`
  ).run(
    PID,
    JSON.stringify({
      productName: '旧标题',
      material: '铝合金',
      productSize: '10x5cm',
      productWeight: '48g',
      colors: '黑色',
      features: '可折叠',
      cartonDimensions: '30 x 20 x 15 cm',
      unitsPerCarton: '100',
      cartonGrossWeight: '8kg',
    }),
    NOW,
    NOW
  )

  db.prepare('INSERT INTO drafts (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    DRAFT_ID,
    '旧标题',
    JSON.stringify({ source: { sourceTitle: '旧标题', priceCny: 8, sizeCn: '10x5cm' }, evaluation: { score: 70 } }),
    NOW,
    NOW
  )

  const reviewListing = JSON.stringify({
    title: 'Old English Title',
    summary: 'Old summary',
    description: 'Old description',
    material: 'Aluminum',
    colors: 'Black',
    colorChips: ['Black'],
    productSizeInch: '3.94" W x 1.97" H',
    unitWeightLb: 0.11,
    cartonSizeInch: '11.81" L x 7.87" W x 5.91" H',
    cartonGwLb: 17.64,
    packaging: 'Individual poly bag; 100 pcs per carton, 30 x 20 x 15 cm, 8 kg per carton.',
    warnings: [],
    priceGrid: [{ qty: 100, shipping: 'air', billableKg: 8, unitCostCny: 12, markupRate: 1.4, unitPrice: 2.4, margin: 10 }],
  })
  db.prepare(
    `INSERT INTO listing_reviews (id, title, source_url, image, source, listing, price_grid, status, product_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', 'pending', ?, ?, ?)`
  ).run(
    'sync-test-review-pending',
    '旧标题',
    'https://detail.1688.com/offer/1.html',
    'https://old.example/1.jpg',
    JSON.stringify({ sourceTitle: '旧标题', priceCny: 8, materialCn: '铝合金', colorsCn: '黑色' }),
    reviewListing,
    PID,
    NOW,
    NOW
  )
  db.prepare(
    `INSERT INTO listing_reviews (id, title, source_url, image, source, listing, price_grid, status, product_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', 'approved', ?, ?, ?)`
  ).run(
    'sync-test-review-approved',
    '旧标题',
    'https://detail.1688.com/offer/1.html',
    'https://old.example/1.jpg',
    JSON.stringify({ sourceTitle: '旧标题', priceCny: 8 }),
    reviewListing,
    PID,
    NOW,
    NOW
  )
}

const master: MasterProduct = {
  id: MID,
  offerId: '1',
  sourceUrl: 'https://detail.1688.com/offer/1.html',
  title: '新标题：304 不锈钢保温杯',
  priceCny: 12,
  sizeCn: '12*3*0.5',
  weightG: 48,
  cartonLCm: 33,
  cartonWCm: 26,
  cartonHCm: 27,
  pcsPerCarton: 200,
  cartonGwKg: 11,
  images: ['https://new.example/a.jpg', 'https://new.example/b.jpg'],
  notes: '新备注：杯口有硅胶圈',
  supplier: '新供应商',
  materialCn: '不锈钢',
  colorsCn: '黑色/银色',
  createdAt: NOW,
  updatedAt: NOW,
}

describe('资料库改一条，所有区块同步', () => {
  beforeAll(() => {
    seed()
    syncMasterToProducts(master)
  })

  test('产品档案：标题/备注/图片/材质/颜色/价格/尺寸/箱规全部更新', () => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(PID) as Record<string, unknown>
    expect(p.source_title).toBe(master.title)
    expect(p.notes).toBe(master.notes)
    expect(JSON.parse(String(p.images))).toEqual(master.images)
    expect(p.material_cn).toBe('不锈钢')
    expect(p.colors_cn).toBe('黑色/银色')
    expect(p.price_cny).toBe(12)
    expect(p.size_cn).toBe('12*3*0.5')
    expect(p.carton_l_cm).toBe(33)
    expect(p.pcs_per_carton).toBe(200)
    expect(p.carton_gw_kg).toBe(11)
    expect(p.eval_review).toBe('pending')
  })

  test('已保存的英文链接：尺寸/重量/箱规/颜色/材质/包装箱规一起改', () => {
    const p = db.prepare('SELECT listing FROM products WHERE id = ?').get(PID) as { listing: string }
    const l = JSON.parse(p.listing) as Record<string, unknown>
    expect(l.productSizeInch).toBe('4.72" L x 1.18" W x 0.20" H')
    expect(l.unitWeightLb).toBe(0.11)
    expect(l.cartonSizeInch).toBe('12.99" L x 10.24" W x 10.63" H')
    expect(l.cartonGwLb).toBe(24.25)
    expect(l.colors).toBe('Black/Silver')
    expect(l.material).toBe('Stainless Steel')
    expect(String(l.packaging)).toContain('200 pcs per carton, 33 x 26 x 27 cm, 11 kg per carton')
    expect(Array.isArray(l.warnings) ? (l.warnings as string[]).join(' ') : '').toContain('Source material changed')
  })

  test('价格表按新成本重算，人工档位/倍率/运输方式保留', () => {
    const p = db.prepare('SELECT listing FROM products WHERE id = ?').get(PID) as { listing: string }
    const grid = (JSON.parse(p.listing) as { priceGrid: Array<Record<string, unknown>> }).priceGrid
    expect(grid).toHaveLength(1)
    expect(grid[0].qty).toBe(100)
    expect(grid[0].markupRate).toBe(1.4)
    expect(grid[0].shipping).toBe('air')
    expect(Number(grid[0].unitCostCny)).toBeGreaterThan(12)
  })

  test('结构化资料：重叠字段更新，其他字段保留', () => {
    const row = db.prepare('SELECT data, unknown_fields FROM product_specs WHERE product_id = ?').get(PID) as {
      data: string
      unknown_fields: string
    }
    const data = JSON.parse(row.data) as Record<string, string>
    expect(data.productName).toBe(master.title)
    expect(data.material).toBe('不锈钢')
    expect(data.productSize).toBe('12*3*0.5')
    expect(data.productWeight).toBe('48g')
    expect(data.colors).toBe('黑色/银色')
    expect(data.cartonDimensions).toBe('33 x 26 x 27 cm')
    expect(data.unitsPerCarton).toBe('200')
    expect(data.cartonGrossWeight).toBe('11kg')
    expect(data.features).toBe('可折叠')
    expect(JSON.parse(row.unknown_fields)).not.toContain('productSize')
  })

  test('评估库草稿里的 source 快照同步', () => {
    const d = db.prepare('SELECT content FROM drafts WHERE id = ?').get(DRAFT_ID) as { content: string }
    const content = JSON.parse(d.content) as { source: Record<string, unknown> }
    expect(content.source.priceCny).toBe(12)
    expect(content.source.sourceTitle).toBe(master.title)
    expect(content.source.sizeCn).toBe('12*3*0.5')
    expect(content.source.images).toEqual(master.images)
  })

  test('待审核 + 已通过审核记录都同步（source/标题/图片/可确定字段）', () => {
    for (const status of ['pending', 'approved']) {
      const rv = db
        .prepare('SELECT * FROM listing_reviews WHERE product_id = ? AND status = ?')
        .get(PID, status) as Record<string, unknown>
      expect(rv.title).toBe(master.title)
      expect(rv.image).toBe(master.images[0])
      const source = JSON.parse(String(rv.source)) as Record<string, unknown>
      expect(source.priceCny).toBe(12)
      expect(source.materialCn).toBe('不锈钢')
      const l = JSON.parse(String(rv.listing)) as Record<string, unknown>
      expect(l.productSizeInch).toBe('4.72" L x 1.18" W x 0.20" H')
      expect(l.colors).toBe('Black/Silver')
    }
  })

  test('图片/标题/材质/颜色变了 → 清掉产品识图与风格匹配缓存，下次按新资料重认', () => {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM product_visual_profiles WHERE product_id = ?')
      .get(PID) as { n: number }
    expect(row.n).toBe(0)
  })
})
