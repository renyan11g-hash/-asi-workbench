/**
 * 表头兜底：图片列换个写法也得认出来。
 *
 * 真实事故：用户表头写的是「商品图片地址」，别名表里没有，整列图片被静默丢掉，
 * 导入结果显示「成功」但一条图都没有。这里锁住兜底规则。
 */

import { looksLikeImageHeader } from '../modules/master-products'

describe('looksLikeImageHeader', () => {
  it('认常见的图片列写法', () => {
    for (const h of ['商品图片地址', '图片', '图片地址', '主图', '商品主图', '产品图片', 'Photo URL', 'image', 'Pictures']) {
      expect(looksLikeImageHeader(h)).toBe(true)
    }
  })

  it('不把文字说明列当图片列', () => {
    for (const h of ['图片说明', '图片备注', '图片描述', '图片数量', '图片张数']) {
      expect(looksLikeImageHeader(h)).toBe(false)
    }
  })

  it('普通列一律不认', () => {
    for (const h of ['商品名称', '采购价(元)', '箱规长(cm)', '备注', '']) {
      expect(looksLikeImageHeader(h)).toBe(false)
    }
  })
})
