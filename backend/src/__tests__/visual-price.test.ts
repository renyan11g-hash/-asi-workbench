/**
 * 识图比价测试。
 *
 * 背景：用户实测指出——按标题判"同形态"挑出来的链接点进去是别的东西（三件套 vs 单本笔记本），
 * 所以价格只能靠识图。这里锁死四件事：
 *   1. 没有我司产品图 → 明确说不能比价，不编区间；
 *   2. 视觉模型确认的同款才进价格带（低把握的不算）；
 *   3. 一条都没确认 → 不给价格，明确提示别拿标题价格带下结论；
 *   4. 视觉模型挂了 → 降级，不影响评估。
 */

jest.mock('../services/ai', () => ({ callChatJson: jest.fn() }))

import { callChatJson } from '../services/ai'
import { buildVisualPriceCheck } from '../services/visual-price'
import type { MarketSnapshot } from '../services/market-probe'
import type { Settings } from '../types'

const mockChat = callChatJson as unknown as jest.Mock

const settings = { aiApiKey: 'k', aiModel: 'm', aiBaseUrl: 'https://x' } as unknown as Settings

function marketWith(espPrices: Array<[string, number]>, qlp?: Array<[string, number]>): MarketSnapshot {
  return {
    queries: ['bamboo notebook gift set'],
    total: 3,
    matched: 1,
    densityCount: 1,
    matchTokens: ['bamboo'],
    items: [],
    price: null,
    densityScore: 62,
    spreadScore: 50,
    diffEstimate: 57,
    competitionEstimate: 50,
    esp: {
      queries: ['bamboo notebook gift set'],
      total: 100,
      byQuery: [],
      matchedSample: 5,
      sampleSize: 20,
      matchTokens: ['bamboo'],
      categories: [],
      items: espPrices.map(([title, priceMin]) => ({
        title,
        productNo: 'X',
        priceMin,
        url: 'https://supplier.espwebsite.com/ProductDetails/?productId=1',
        image: 'https://media-asicdn.azureedge.net/x.jpg',
        form: 'set' as const,
      })),
      price: null,
      densityScore: 62,
      fallback: false,
      fetchedAt: '',
    },
    ...(qlp
      ? {
          demand: {
            checked: 1,
            carriers: 1,
            bestCount: qlp.length,
            demandScore: 45,
            note: 'n',
            price: null,
            sources: [
              {
                id: 'qlp',
                name: 'Quality Logo Products',
                ok: true,
                total: 17,
                sampleSize: 17,
                matched: qlp.length,
                sameFormCount: 0,
                price: null,
                priceSameForm: null,
                items: qlp.map(([title, priceMin]) => ({
                  title,
                  priceMin,
                  url: 'https://www.qualitylogoproducts.com/x.htm',
                  image: 'https://www.qualitylogoproducts.com/x.jpg',
                  form: 'set' as const,
                })),
              },
            ],
            fetchedAt: '',
          },
        }
      : {}),
    fetchedAt: '',
  }
}

describe('buildVisualPriceCheck', () => {
  beforeEach(() => mockChat.mockReset())

  it('没有我司产品图 → 明确说不能比价，不给价格带', async () => {
    const r = await buildVisualPriceCheck(settings, [], '竹木三件套礼盒（套装）', marketWith([['A', 10], ['B', 12]]))
    expect(r?.price).toBeNull()
    expect(r?.sameCount).toBe(0)
    expect(r?.note).toContain('没有我司产品图')
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('只确认 2 条时按偏少样本给价格带（用户要求大致相似即可比价）', async () => {
    mockChat.mockResolvedValue({
      results: [
        { n: 1, same: true, confidence: 0.92, reason: '三件套礼盒，结构一致' },
        { n: 2, same: true, confidence: 0.3, reason: '不太确定' },
      ],
    })
    const r = await buildVisualPriceCheck(
      settings,
      ['https://example.com/ours.jpg'],
      '竹木三件套礼盒（套装）',
      marketWith([
        ['Real Same Set', 12],
        ['Maybe Same Set', 30],
      ])
    )
    expect(r?.checked).toBe(2)
    // 低把握不算同款 → 只剩 1 条可用 → 不给价格带
    expect(r?.sameCount).toBe(1)
    expect(r?.price).toBeNull()
    expect(r?.note).toContain('只确认 1 条同款')
    expect(r?.items.find((i) => i.title === 'Maybe Same Set')?.same).toBe(true)
  })

  it('价格明显异常的同款只标注、不剔除（可能确实是大货价）', async () => {
    mockChat.mockResolvedValue({
      results: [
        { n: 1, same: true, confidence: 0.97, reason: '同款' },
        { n: 2, same: true, confidence: 0.95, reason: '同款' },
        { n: 3, same: true, confidence: 0.95, reason: '同款' },
        { n: 4, same: true, confidence: 0.96, reason: '同款但价格明显是供应商填错' },
      ],
    })
    const m = marketWith([
      ['Cheap Wrong Price', 0.86],
      ['Set A', 9],
      ['Set B', 11],
      ['Set C', 13],
    ])
    // 标题同类中位 11 → 0.86 明显异常
    m.esp!.priceSameForm = { min: 9, p25: 9, median: 11, p75: 13, max: 13 }
    const r = await buildVisualPriceCheck(settings, ['https://example.com/ours.jpg'], '竹木三件套礼盒（套装）', m)
    expect(r?.items.find((i) => i.title === 'Cheap Wrong Price')?.suspicious).toBe(true)
    // 4 条全部算进价格带（异常只标注）
    expect(r?.sameCount).toBe(4)
    expect(r?.price?.min).toBe(0.86)
    expect(r?.price?.max).toBe(13)
    expect(r?.note).toContain('价格明显低于同类')
  })

  it('跨来源同款一起算价格带（ESP + 分销商）', async () => {
    mockChat.mockResolvedValue({
      results: [
        { n: 1, same: true, confidence: 0.9 },
        { n: 2, same: true, confidence: 0.9 },
        { n: 3, same: true, confidence: 0.9 },
      ],
    })
    const r = await buildVisualPriceCheck(
      settings,
      ['https://example.com/ours.jpg'],
      'x',
      marketWith(
        [['ESP A', 8], ['ESP B', 11]],
        [['QLP A', 14]]
      )
    )
    expect(r?.checked).toBe(3)
    expect(r?.sameCount).toBe(3)
    expect(r?.price?.min).toBe(8)
    expect(r?.price?.max).toBe(14)
  })

  it('一条都没确认 → 不给价格，并提示别拿标题价格带下结论', async () => {
    mockChat.mockResolvedValue({
      results: [
        { n: 1, same: false, confidence: 0.9, reason: '单本笔记本，两件套' },
        { n: 2, same: false, confidence: 0.8, reason: '材质不同' },
      ],
    })
    const r = await buildVisualPriceCheck(
      settings,
      ['https://example.com/ours.jpg'],
      '竹木三件套礼盒（套装）',
      marketWith([
        ['Single Notebook', 5],
        ['Two Piece Set', 9],
      ])
    )
    expect(r?.price).toBeNull()
    expect(r?.sameCount).toBe(0)
    expect(r?.note).toContain('没有一条是同款')
  })

  it('视觉模型失败 → 降级，不影响评估', async () => {
    mockChat.mockRejectedValue(new Error('model does not support images'))
    const r = await buildVisualPriceCheck(
      settings,
      ['https://example.com/ours.jpg'],
      'x',
      marketWith([['A', 10]])
    )
    expect(r?.price).toBeNull()
    expect(r?.note).toContain('视觉模型')
  })

  it('候选包含分销商商品（跨来源一起比价）', async () => {
    mockChat.mockResolvedValue({
      results: [
        { n: 1, same: true, confidence: 0.9 },
        { n: 2, same: true, confidence: 0.9 },
        { n: 3, same: true, confidence: 0.9 },
      ],
    })
    const r = await buildVisualPriceCheck(
      settings,
      ['https://example.com/ours.jpg'],
      'x',
      marketWith(
        [['ESP A', 8], ['ESP B', 11]],
        [['QLP A', 14]]
      )
    )
    expect(r?.checked).toBe(3)
    expect(r?.sameCount).toBe(3)
    expect(r?.price?.min).toBe(8)
    expect(r?.price?.max).toBe(14)
  })
})
