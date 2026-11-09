/**
 * 视觉风格体系 · 数据层测试（真实建表 + 真实 SQLite，不调 AI）
 *
 * 覆盖：参考图入库/分类/收藏/启停、风格配置版本与默认、品类匹配、
 * 确认尺寸 → 标注参数、反馈汇总。图片用 1×1 PNG，不依赖外部网络。
 */

import {
  addVisualRef,
  createVisualStyle,
  deleteVisualRef,
  dimensionSpecOf,
  getVisualRef,
  getVisualStyle,
  listVisualRefs,
  matchStyleLocal,
  pickRefsForStyle,
  recordImageFeedback,
  saveDimensions,
  styleBlockOf,
  updateVisualRef,
  updateVisualStyle,
  feedbackSummary,
} from '../services/visual-styles'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

describe('视觉参考库', () => {
  test('上传 → 分类/收藏/备注/启停都能改；删除后真身一起清掉', async () => {
    const ref = await addVisualRef({
      buffer: PNG_1PX,
      mime: 'image/png',
      category: 'main',
      title: 'ASI 同行主图',
      note: '白底、产品占比 60%',
      favorite: true,
      origin: 'upload',
    })
    expect(ref.url).toBe(`/api/visual-styles/refs/${ref.id}/image`)
    expect(ref.category).toBe('main')
    expect(ref.favorite).toBe(true)

    const updated = updateVisualRef(ref.id, { category: 'scene', verdict: 'good', favorite: false, note: '改了' })
    expect(updated.category).toBe('scene')
    expect(updated.verdict).toBe('good')
    expect(updated.favorite).toBe(false)
    expect(updated.note).toBe('改了')

    const listed = listVisualRefs({ category: 'scene' })
    expect(listed.some((r) => r.id === ref.id)).toBe(true)

    deleteVisualRef(ref.id)
    expect(() => getVisualRef(ref.id)).toThrow()
  })

  test('不合格案例不会进入风格参考候选', async () => {
    const bad = await addVisualRef({ buffer: PNG_1PX, category: 'showcase', verdict: 'bad' })
    const good = await addVisualRef({ buffer: PNG_1PX, category: 'main', verdict: 'good', favorite: true })
    const picked = pickRefsForStyle(null, {
      category: '保温杯',
      categoryEn: 'tumbler',
      colors: [],
      structure: '',
      material: '',
      accessories: [],
      usageScenes: [],
      confidence: 'low',
      source: 'fallback',
      note: '',
    })
    expect(picked.some((r) => r.id === bad.id)).toBe(false)
    expect(picked.some((r) => r.id === good.id)).toBe(true)
    deleteVisualRef(bad.id)
    deleteVisualRef(good.id)
  })
})

describe('视觉风格配置', () => {
  test('新建 → 改 profile/promptBlock → 版本与默认标记正确', () => {
    const style = createVisualStyle({
      name: 'ASI 简约白底',
      scope: 'global',
      category: '保温杯,蓝牙音箱',
      isDefault: true,
      promptBlock: 'Soft studio lighting, pure white sweep, 60% product coverage, generous whitespace.',
      profile: { summary: '简洁白底', composition: '居中' },
    })
    expect(style.version).toBe(1)
    expect(style.isDefault).toBe(true)
    expect(styleBlockOf(style)).toContain('Soft studio lighting')

    const updated = updateVisualStyle(style.id, {
      profile: { lighting: '柔和顶部柔光箱', promptBlock: 'Updated style block.' },
    })
    expect(updated.profile.lighting).toBe('柔和顶部柔光箱')
    expect(styleBlockOf(updated)).toBe('Updated style block.')
  })

  test('品类命中优先；没命中用默认风格并说明原因', () => {
    const a = createVisualStyle({ name: '杯类风格', scope: 'category', category: '保温杯,水杯' })
    const b = createVisualStyle({ name: '通用风格', scope: 'global', isDefault: true })
    const ident = {
      category: '保温杯',
      categoryEn: 'tumbler',
      colors: [],
      structure: '',
      material: '不锈钢',
      accessories: [],
      usageScenes: [],
      confidence: 'high' as const,
      source: 'ai' as const,
      note: '',
    }
    const hit = matchStyleLocal({ sourceTitle: '不锈钢保温杯' }, ident, [a, b])
    expect(hit.style?.id).toBe(a.id)
    expect(hit.reason).toContain('品类命中')

    const miss = matchStyleLocal({ sourceTitle: '塑料收纳盒' }, { ...ident, category: '收纳盒', categoryEn: 'box' }, [a, b])
    expect(miss.style?.id).toBe(b.id)
    expect(miss.reason).toContain('默认风格')
    expect(getVisualStyle(b.id).isDefault).toBe(true)
  })
})

describe('确认尺寸 → 尺寸图参数', () => {
  test('长宽高厚度各自对应，厚度进图例而不是乱画线', () => {
    const dims = saveDimensions('test-product-dims', {
      lengthIn: 12,
      widthIn: 4.5,
      heightIn: 9,
      thicknessIn: 1.2,
      extra: [{ label: 'Handle', value: 3 }],
    })
    const spec = dimensionSpecOf(dims)
    expect(spec).not.toBeNull()
    expect(spec?.widthIn).toBe(12) // 底部 = 长
    expect(spec?.heightIn).toBe(9) // 右侧 = 高
    expect(spec?.depthIn).toBe(4.5) // 斜线 = 宽
    expect(spec?.legend).toContain('T 1.2"')
    expect(spec?.legend).toContain('Handle 3.0"')
  })

  test('缺少长/高就不出尺寸图（不能猜）', () => {
    const dims = saveDimensions('test-product-dims-2', { widthIn: 5 })
    expect(dimensionSpecOf(dims)).toBeNull()
  })

  test('尺寸全部是用户填的数字，不被资料库字符串覆盖', () => {
    const dims = saveDimensions('test-product-dims-3', { lengthIn: 7.1, heightIn: 3.3 })
    expect(dims.lengthIn).toBe(7.1)
    expect(dims.heightIn).toBe(3.3)
  })
})

describe('图片满意度反馈', () => {
  test('满意/不满意都入账，原因可汇总', () => {
    recordImageFeedback({
      imageId: 'img-1',
      productId: 'p-1',
      verdict: 'dislike',
      reasons: ['product_color', 'background'],
      promptVersion: 'pv-abc',
    })
    recordImageFeedback({ imageId: 'img-2', productId: 'p-1', verdict: 'like' })
    const summary = feedbackSummary()
    expect(summary.total).toBeGreaterThanOrEqual(2)
    expect(summary.likes).toBeGreaterThanOrEqual(1)
    expect(summary.reasons.find((r) => r.key === 'product_color')?.count).toBeGreaterThanOrEqual(1)
  })
})
