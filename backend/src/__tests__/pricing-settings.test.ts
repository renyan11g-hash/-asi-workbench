/**
 * 会员折扣口径 + 单产品定价参数测试。
 *
 * 业务事实：我们挂到 ASI/ESP 的价格 ÷ 0.6 = 网站上非会员看到的 list 价。
 * 所以拿到别人 list 价后要 ×0.6 才和我们的阶梯价同一把尺子。
 * 另外不同产品要能各自调汇率/运费/印刷费等，不能改全局把别的产品也带歪。
 */

import { applyMemberDiscount } from '../services/market-probe'
import type { MarketSnapshot } from '../services/market-probe'
import { settingsForProduct } from '../modules/products'

function snap(): MarketSnapshot {
  return {
    queries: ['q'],
    total: 3,
    matched: 1,
    densityCount: 1,
    matchTokens: ['x'],
    items: [{ title: 'A', priceMin: 10, priceMax: 12, url: '' }],
    price: { min: 10, p25: 10, median: 12, p75: 14, max: 20 },
    densityScore: 60,
    spreadScore: 50,
    diffEstimate: 56,
    competitionEstimate: 55,
    esp: {
      queries: ['q'],
      total: 100,
      byQuery: [],
      matchedSample: 4,
      sampleSize: 20,
      matchTokens: ['x'],
      categories: [],
      items: [
        {
          title: 'ESP A',
          productNo: 'P1',
          priceMin: 10,
          url: 'https://x',
          form: 'single',
        },
      ],
      price: { min: 5, p25: 10, median: 20, p75: 30, max: 40 },
      densityScore: 60,
      fallback: false,
      fetchedAt: '',
    },
    demand: {
      checked: 1,
      carriers: 1,
      bestCount: 3,
      demandScore: 45,
      note: 'n',
      price: { min: 8, p25: 9, median: 11, p75: 13, max: 15 },
      sources: [
        {
          id: 'qlp',
          name: 'QLP',
          ok: true,
          total: 10,
          sampleSize: 10,
          matched: 3,
          sameFormCount: 1,
          price: { min: 8, p25: 9, median: 11, p75: 13, max: 15 },
          priceSameForm: { min: 8, p25: 9, median: 11, p75: 13, max: 15 },
          items: [{ title: 'Q', priceMin: 9, url: 'https://y', form: 'single' }],
        },
      ],
      fetchedAt: '',
    },
    priceCheck: {
      checked: 2,
      confirmedCount: 2,
      sameCount: 2,
      price: { min: 10, p25: 10, median: 12, p75: 14, max: 20 },
      items: [{ title: 'V', priceMin: 10, url: 'https://z', source: 'ESP', same: true, confidence: 0.9 }],
      note: '',
    },
    fetchedAt: '',
  }
}

describe('applyMemberDiscount', () => {
  it('所有价格字段统一乘 0.6（区间、单条、分销商、识图样本）', () => {
    const d = applyMemberDiscount(snap(), 0.6)
    expect(d.memberDiscount).toBe(0.6)
    expect(d.price).toEqual({ min: 6, p25: 6, median: 7.2, p75: 8.4, max: 12 })
    expect(d.items[0].priceMin).toBe(6)
    expect(d.items[0].priceMax).toBe(7.2)
    expect(d.esp!.price!.median).toBe(12)
    expect(d.esp!.items[0].priceMin).toBe(6)
    expect(d.demand!.price!.p75).toBe(7.8)
    expect(d.demand!.sources[0].items[0].priceMin).toBe(5.4)
    expect(d.priceCheck!.items[0].priceMin).toBe(6)
  })

  it('折扣为 1 或非法值时不折算（避免误伤）', () => {
    expect(applyMemberDiscount(snap(), 1).memberDiscount).toBeUndefined()
    expect(applyMemberDiscount(snap(), 0).memberDiscount).toBeUndefined()
    expect(applyMemberDiscount(snap(), NaN).price!.p25).toBe(10)
  })
})

describe('settingsForProduct', () => {
  it('本产品覆盖优先，未覆盖的字段跟随全局', () => {
    const s = settingsForProduct({ priceSettings: { fxRate: 7.123, printCostCny: 3 } })
    expect(s.fxRate).toBe(7.123)
    expect(s.printCostCny).toBe(3)
    // 没覆盖到的仍是全局默认
    expect(s.airRateCnyPerKg).toBeGreaterThan(0)
    expect(typeof s.seaRateCnyPerKg).toBe('number')
  })

  it('没有覆盖时完全等于全局设置', () => {
    const a = settingsForProduct({})
    const b = settingsForProduct({ priceSettings: null })
    expect(a.fxRate).toBe(b.fxRate)
    expect(a.espMemberDiscount ?? 0.6).toBeGreaterThan(0)
  })
})
