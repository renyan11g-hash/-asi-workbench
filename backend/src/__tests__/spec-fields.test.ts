import { cleanValue, emptySpecs, isKnown, normalizeSpecs, SPEC_KEYS, specsToPromptBlock, UNKNOWN } from '../services/spec-fields'

/**
 * 结构化资料的硬要求：资料里没有的一律 Unknown，绝不能编。
 * 这些测试守的就是「AI 编造参数」这条底线 —— 也是批量生成最容易出事的地方。
 */
describe('产品结构化资料：清洗与完整性', () => {
  it('缺字段一律补 Unknown，多出来的键丢掉', () => {
    const { specs, unknownFields, filled } = normalizeSpecs({
      material: '304 不锈钢',
      productSize: '20 x 8 cm',
      madeUpField: '编造的内容',
    })
    expect(Object.keys(specs).sort()).toEqual([...SPEC_KEYS].sort())
    expect(specs.material).toBe('304 不锈钢')
    expect(specs.productSize).toBe('20 x 8 cm')
    expect((specs as unknown as Record<string, unknown>).madeUpField).toBeUndefined()
    expect(unknownFields).toHaveLength(SPEC_KEYS.length - 2)
    expect(filled).toBe(2)
  })

  it('各种「等于没写」的写法都归一成 Unknown', () => {
    for (const v of ['', '   ', 'Unknown', 'unknown', 'N/A', 'n/a', '未知', '-', 'None']) {
      expect(isKnown(v)).toBe(false)
      expect(cleanValue(v)).toBe(UNKNOWN)
    }
    expect(isKnown('PP 塑料')).toBe(true)
  })

  it('单个字段压到 500 字以内，避免整篇详情塞进一格', () => {
    const long = 'x'.repeat(900)
    const v = cleanValue(long)
    expect(v.length).toBeLessThanOrEqual(500)
    expect(v.endsWith('…')).toBe(true)
  })

  it('未知字段不进提示词（否则模型会把 Unknown 当事实）', () => {
    const specs = { ...emptySpecs(), material: 'PU 皮', unitsPerCarton: '60' }
    const block = specsToPromptBlock(specs)
    expect(block).toContain('Material: PU 皮')
    expect(block).toContain('Units Per Carton: 60')
    expect(block).not.toContain('Unknown')
  })

  it('全空资料不产生提示词块', () => {
    expect(specsToPromptBlock(emptySpecs())).toBe('')
  })
})
