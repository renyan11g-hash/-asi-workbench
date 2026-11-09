import { db } from '../db'
import { restoreImageVersion } from '../modules/product-images'

/**
 * 历史版本（archived）必须能恢复成当前版本，而且任何时候同一图种/槽位只能有一张「当前图」。
 * 2026-11-09 用户要求「历史版本图片支持查看」，恢复动作是配套能力。
 */

const PID = 'restore-test-product'

function seed(id: string, kind: string, slot: number, archived: 0 | 1, createdAt: string): void {
  db.prepare(
    `INSERT INTO product_images (id, product_id, kind, slot, prompt, history, file, with_logo, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', '[]', ?, 1, ?, ?, ?)`
  ).run(id, PID, kind, slot, `${id}.png`, archived, createdAt, createdAt)
}

function currentIds(kind: string, slot = 0): string[] {
  return (db.prepare('SELECT id FROM product_images WHERE product_id = ? AND kind = ? AND slot = ? AND archived = 0').all(PID, kind, slot) as unknown as Array<{ id: string }>).map(
    (r) => r.id
  )
}

describe('历史版本恢复', () => {
  beforeAll(() => {
    db.prepare('DELETE FROM product_images WHERE product_id = ?').run(PID)
    seed('img-old', 'main', 0, 1, '2026-11-01T00:00:00.000Z')
    seed('img-new', 'main', 0, 0, '2026-11-02T00:00:00.000Z')
    seed('img-detail', 'detail', 1, 0, '2026-11-03T00:00:00.000Z')
  })

  test('恢复历史版本：目标变当前，原来的当前图转历史（不删除）', () => {
    const images = restoreImageVersion(PID, 'img-old')
    expect(images.map((i) => i.id).sort()).toEqual(['img-detail', 'img-new', 'img-old'])
    expect(currentIds('main')).toEqual(['img-old'])
    const old = images.find((i) => i.id === 'img-new')
    expect(old?.archived).toBe(true)
    const restored = images.find((i) => i.id === 'img-old')
    expect(restored?.archived).toBe(false)
  })

  test('同一图种/槽位永远只有一张当前图；别的图种不受影响', () => {
    restoreImageVersion(PID, 'img-new')
    expect(currentIds('main')).toEqual(['img-new'])
    expect(currentIds('detail', 1)).toEqual(['img-detail'])
    const total = db.prepare('SELECT COUNT(*) as c FROM product_images WHERE product_id = ?').get(PID) as {
      c: number
    }
    expect(total.c).toBe(3) // 恢复不会删任何版本
  })

  test('当前图重复恢复自己：仍是唯一当前图', () => {
    restoreImageVersion(PID, 'img-new')
    expect(currentIds('main')).toEqual(['img-new'])
  })

  test('不存在的图片 id → 报错而不是静默成功', () => {
    expect(() => restoreImageVersion(PID, 'no-such-image')).toThrow()
  })
})
