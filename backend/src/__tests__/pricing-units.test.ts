/**
 * 尺寸换算测试：1688 资料库里尺寸经常不写单位（"12*3*0.5" / "14.6x10"），
 * 以前只认带 cm 的写法，导致生成的英文链接产品尺寸为空（ASI 必填项）。
 * 这里锁住：默认按 cm、支持长宽高三维、mm/inch 换算、容量文案不误判。
 */

import { convertUnits, parseProductSizeCm } from '../services/pricing'
import type { SourceInfo } from '../types'

const sizeOf = (sizeCn: string) => convertUnits({ sizeCn, weightG: 100 } as SourceInfo)

describe('产品尺寸换算（Listing 用）', () => {
  test('没有单位的 3 个数按 cm 处理，输出长/宽/高', () => {
    expect(sizeOf('12*3*0.5').productSizeInch).toBe('4.72" L x 1.18" W x 0.20" H')
  })

  test('没有单位的 2 个数按 cm 处理，输出宽 x 高', () => {
    expect(sizeOf('14.6x10').productSizeInch).toBe('5.75" W x 3.94" H')
  })

  test('明确写 cm 的两维尺寸保持原写法', () => {
    expect(sizeOf('8x12cm').productSizeInch).toBe('3.15" W x 4.72" H')
  })

  test('mm / inch 正确换算', () => {
    expect(sizeOf('100x50x20mm').productSizeInch).toBe('3.94" L x 1.97" W x 0.79" H')
    expect(sizeOf('10x4x1 inch').productSizeInch).toBe('10.00" L x 4.00" W x 1.00" H')
  })

  test('直径写法', () => {
    expect(sizeOf('直径7cm').productSizeInch).toBe('2.76" Diameter')
    expect(sizeOf('Ø 2.5 inch').productSizeInch).toBe('2.50" Diameter')
  })

  test('容量/重量文案不会被当成尺寸', () => {
    expect(sizeOf('2x500ml').productSizeInch).toBe('')
    expect(sizeOf('200g').productSizeInch).toBe('')
  })

  test('厘米解析：三维取第三个数字，二维沿用 h=w', () => {
    expect(parseProductSizeCm('12*3*0.5', 48)).toEqual({ l: 12, w: 3, h: 0.5 })
    expect(parseProductSizeCm('14.6x10', 200)).toEqual({ l: 14.6, w: 10, h: 10 })
    expect(parseProductSizeCm('8x12cm', 100)).toEqual({ l: 8, w: 12, h: 12 })
  })
})
