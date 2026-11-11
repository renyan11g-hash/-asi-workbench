/**
 * 「待审核」版本的派生数据同步（用户报障：编辑页改箱规后价格没变）。
 *
 * 根因：批量生成的文案先停在审核库（products.listing 还是 null），编辑页显示的是
 * listing_reviews 里那条草稿。如果重算只写 products.listing，用户改完箱规看到的
 * 还是旧价。这条测试把「价格表必须写进待审核草稿」钉住。
 */

import { db } from '../db'
import { syncStagedReviewListing } from '../modules/products'

const PID = 'staged-sync-product-1'
const RID = 'staged-sync-review-1'
const NOW = new Date().toISOString()

const row = (qty: number, billableKg: number, unitPrice: number) => ({
  qty,
  billableKg,
  unitCostCny: 18.5,
  unitCost: 2.77,
  fixedCostUsd: 3.21,
  miscUsd: 0.2,
  allInCostUsd: 3.41,
  grossProfit: 0.49,
  grossProfitCny: 3.28,
  totalGrossProfitUsd: 49,
  totalGrossProfitCny: 327.9,
  unitPrice,
  margin: 12.6,
  shipping: 'air' as const,
  markupRate: 1.4,
  code: '8C',
})

const oldGrid = [row(100, 24, 3.9)]
const newGrid = [row(50, 36, 4.75)]

function seed() {
  db.prepare('DELETE FROM listing_reviews WHERE id = ?').run(RID)
  db.prepare('DELETE FROM products WHERE id = ?').run(PID)
  db.prepare(
    `INSERT INTO products (id, source_title, source_url, status, listing, created_at, updated_at)
     VALUES (?, ?, ?, 'pending_review', NULL, ?, ?)`
  ).run(PID, '测试产品', 'https://detail.1688.com/offer/1.html', NOW, NOW)
  db.prepare(
    `INSERT INTO listing_reviews
      (id, mode, title, source_url, listing, price_grid, status, product_id, created_at, updated_at)
     VALUES (?, 'staged', ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(
    RID,
    '测试产品',
    'https://detail.1688.com/offer/1.html',
    JSON.stringify({ title: 'Old Title', priceGrid: oldGrid }),
    JSON.stringify(oldGrid),
    PID,
    NOW,
    NOW
  )
}

describe('待审核草稿的派生数据同步', () => {
  beforeEach(seed)

  it('产品还没有正式 listing 时，新价格表写进待审核草稿', () => {
    const merged = syncStagedReviewListing(PID, {
      priceGrid: newGrid,
      cartonSizeInch: '24" x 20" x 24"',
      cartonGwLb: 44,
    })
    expect(merged).not.toBeNull()
    expect(merged?.priceGrid?.[0]?.billableKg).toBe(36)
    expect(merged?.title).toBe('Old Title') // 文案内容不动，只改派生数据

    const row = db.prepare('SELECT listing, price_grid FROM listing_reviews WHERE id = ?').get(RID) as {
      listing: string
      price_grid: string
    }
    const listing = JSON.parse(row.listing) as { priceGrid: typeof newGrid }
    expect(listing.priceGrid[0].billableKg).toBe(36)
    expect(JSON.parse(row.price_grid)[0].billableKg).toBe(36)
  })

  it('没有待审核草稿时返回 null（不会误写别的产品）', () => {
    db.prepare('DELETE FROM listing_reviews WHERE id = ?').run(RID)
    expect(syncStagedReviewListing(PID, { priceGrid: newGrid })).toBeNull()
  })
})
