import { buildPriceGrid, retogglePriceRow } from '../services/pricing'
import { DEFAULT_SETTINGS, type PriceRow } from '../types'

/**
 * 2026-11-10 用户要求：点某一档切空运/海运，只变那一档，其它档一律不动。
 *
 * 以前的实现是把整张价格表重新 buildPriceGrid 一遍：之前手动切过的档会被
 * 「前 N 档空运」的自动分配冲回去，人工改过的价格/倍率也会被重算覆盖。
 * 现在就地改一行，这里锁住这个行为。
 */

const source = {
  priceCny: 22,
  weightG: 118,
  cartonLCm: 45,
  cartonWCm: 33,
  cartonHCm: 40,
  pcsPerCarton: 100,
  cartonGwKg: 14.8,
}

function grid(): PriceRow[] {
  return buildPriceGrid(source, DEFAULT_SETTINGS).rows
}

describe('单档切换运输方式', () => {
  test('只改被点的那一档，其它档任何字段都不变', () => {
    const rows = grid()
    const before = rows.map((r) => ({ ...r }))
    const idx = 4
    const after = retogglePriceRow({ source, settings: DEFAULT_SETTINGS, rows, idx, mode: 'air' })

    after.forEach((r, i) => {
      if (i === idx) return
      expect(r).toEqual(before[i])
    })
    expect(after[idx].shipping).toBe('air')
    expect(after[idx].unitPrice).toBeGreaterThan(before[idx].unitPrice) // 海运改空运 → 变贵
  })

  test('该档沿用原来的倍率，不因为切换运输方式被重置', () => {
    const rows = grid()
    const markup = rows[4].markupRate
    const after = retogglePriceRow({ source, settings: DEFAULT_SETTINGS, rows, idx: 4, mode: 'air' })
    expect(after[4].markupRate).toBe(markup)
  })

  test('人工改过的其它档价格（含倍率/数量）原样保留', () => {
    const rows = grid()
    rows[2] = { ...rows[2], unitPrice: 9.99, markupRate: 1.9, qty: 333 }
    const after = retogglePriceRow({ source, settings: DEFAULT_SETTINGS, rows, idx: 5, mode: 'air' })
    expect(after[2].unitPrice).toBe(9.99)
    expect(after[2].markupRate).toBe(1.9)
    expect(after[2].qty).toBe(333)
  })

  test('切到海运后：这一档成本、售价都按新运费重算（倍率不变）', () => {
    const rows = grid()
    const idx = 0 // 首档原本空运
    const after = retogglePriceRow({ source, settings: DEFAULT_SETTINGS, rows, idx, mode: 'sea' })
    expect(after[idx].shipping).toBe('sea')
    expect(after[idx].unitCostCny).toBeLessThan(rows[idx].unitCostCny)
    expect(after[idx].unitPrice).toBeLessThan(rows[idx].unitPrice)
    // 倍率不变，所以「售价 / 到岸成本」的比值保持
    const ratioBefore = rows[idx].unitPrice / rows[idx].unitCostCny
    const ratioAfter = after[idx].unitPrice / after[idx].unitCostCny
    expect(Math.abs(ratioAfter - ratioBefore)).toBeLessThan(0.02)
    expect(after[idx].margin).not.toBe(rows[idx].margin) // 毛利按新成本重算过
  })

  test('连续切两档：先切的那一档不会被后一次切回自动分配', () => {
    let rows = grid()
    rows = retogglePriceRow({ source, settings: DEFAULT_SETTINGS, rows, idx: 3, mode: 'sea' })
    const seaRow = { ...rows[3] }
    rows = retogglePriceRow({ source, settings: DEFAULT_SETTINGS, rows, idx: 6, mode: 'air' })
    expect(rows[3]).toEqual(seaRow)
    expect(rows[6].shipping).toBe('air')
  })

  test('idx 不存在时原样返回，不抛错也不动数据', () => {
    const rows = grid()
    const after = retogglePriceRow({ source, settings: DEFAULT_SETTINGS, rows, idx: 99, mode: 'air' })
    expect(after).toEqual(rows)
  })
})
