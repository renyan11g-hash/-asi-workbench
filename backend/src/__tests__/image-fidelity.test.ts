/**
 * 产品保真独立测试（不调 AI、不读图）。
 *
 * 验收标准里「图片好不好看」是主观的，但「prompt 有没有把 10 条保真规则带齐」
 * 是客观的。这里守的就是这条底线：任何一张图实际发给模型的 prompt 都必须包含
 * 全部保真条款 + 风格参考边界，且保真块永远在最后。
 */

import {
  FIDELITY_RULES,
  STYLE_REF_CLAUSE,
  budgetRefs,
  capabilitiesFor,
  guardPrompt,
  missingFidelityRules,
  planShotSet,
  promptVersionOf,
} from '../services/image-fidelity'

describe('产品保真护栏', () => {
  test('每张图的 prompt 都带齐 10 条保真规则', () => {
    const prompt = guardPrompt('A hero photo of the product.', { kind: 'main', withLogo: true })
    expect(missingFidelityRules(prompt)).toEqual([])
    expect(FIDELITY_RULES).toHaveLength(10)
    for (const rule of FIDELITY_RULES) {
      expect(prompt).toContain(`[${rule.id}]`)
    }
  })

  test('保真块永远在 prompt 末尾（模型对末尾指令更敏感）', () => {
    const prompt = guardPrompt('BASE PROMPT', { kind: 'detail' })
    expect(prompt.indexOf('BASE PROMPT')).toBeLessThan(prompt.indexOf('PRODUCT FIDELITY'))
    expect(prompt.trim().endsWith('PRODUCT FIDELITY WINS.')).toBe(true)
  })

  test('有风格参考图时必须写明「不得复制参考图产品」', () => {
    const withStyle = guardPrompt('base', { kind: 'main', withStyleRefs: true })
    const withoutStyle = guardPrompt('base', { kind: 'main', withStyleRefs: false })
    expect(withStyle).toContain(STYLE_REF_CLAUSE)
    expect(withoutStyle).not.toContain(STYLE_REF_CLAUSE)
    expect(withStyle).toContain('Never copy any product')
  })

  test('Logo 指令随开关变化：不要 Logo 时明确禁止', () => {
    const noLogo = guardPrompt('base', { kind: 'main', withLogo: false })
    expect(noLogo).toContain('No logo, brand mark')
    expect(noLogo).not.toContain('The only permitted mark')
  })

  test('提示词版本稳定且随内容变化（反馈可追溯）', () => {
    expect(promptVersionOf('a')).toBe(promptVersionOf('a'))
    expect(promptVersionOf('a')).not.toBe(promptVersionOf('b'))
    expect(promptVersionOf('a')).toMatch(/^pv-[0-9a-f]{10}$/)
  })
})

describe('拍摄套图规划', () => {
  test('有确认尺寸才出尺寸图（数字不能猜）', () => {
    const withDims = planShotSet({
      title: '不锈钢保温杯',
      material: '不锈钢',
      colors: '黑/白',
      imageCount: 5,
      hasDimensions: true,
    })
    expect(withDims.kinds).toContain('dimension')
    expect(withDims.kinds.filter((k) => k === 'main')).toHaveLength(1)

    const noDims = planShotSet({ title: '不锈钢保温杯', material: '不锈钢', hasDimensions: false })
    expect(noDims.kinds).not.toContain('dimension')
    expect(noDims.reasons.join('')).toContain('不猜数字')
  })

  test('材质丰富/多颜色 → 2 张细节图，场景明确 → 1 张场景图', () => {
    const plan = planShotSet({
      title: '皮质收纳包',
      material: 'PU 皮革',
      colors: '黑/棕',
      imageCount: 6,
      hasDimensions: true,
    })
    expect(plan.detailCount).toBe(2)
    expect(plan.sceneCount).toBe(1)
    expect(plan.kinds.filter((k) => k === 'detail')).toHaveLength(2)
  })

  test('细节 + 场景不超过 3 张；强制图组直接尊重用户选择', () => {
    const plan = planShotSet({ title: '蓝牙音箱', material: 'abs', hasDimensions: true })
    expect(plan.detailCount + plan.sceneCount).toBeLessThanOrEqual(3)
    const forced = planShotSet({ forceKinds: ['main'] })
    expect(forced.kinds).toEqual(['main'])
  })
})

describe('图像模型能力（不假设都支持多参考图）', () => {
  test('火山 Seedream：多参考图 + 编辑，上限 10', () => {
    const caps = capabilitiesFor('https://ark.cn-beijing.volces.com/api/v3', 'doubao-seedream-4-0-250828')
    expect(caps.multiRef).toBe(true)
    expect(caps.supportsEdit).toBe(true)
    expect(caps.maxRefs).toBe(10)
  })

  test('OpenAI 兼容：有参考图走 edits，上限 4', () => {
    const caps = capabilitiesFor('https://api.openai.com/v1', 'gpt-image-1')
    expect(caps.provider).toContain('OpenAI')
    expect(caps.maxRefs).toBe(4)
  })

  test('未识别服务商走保守方案：1 张参考图', () => {
    const caps = capabilitiesFor('https://example.com/v1', 'some-model')
    expect(caps.multiRef).toBe(false)
    expect(caps.maxRefs).toBe(1)
    expect(caps.note).toContain('保守')
  })

  test('参考图预算：产品图优先，风格图不挤掉 Logo', () => {
    const caps = capabilitiesFor('https://ark.cn-beijing.volces.com/api/v3', 'doubao-seedream-4-0-250828')
    const budget = budgetRefs(caps, { product: 8, style: 3, logo: true })
    expect(budget.product).toBe(8)
    expect(budget.style).toBe(1)
    expect(budget.logo).toBe(true)
    // 产品图很多时也不能把风格图放到产品图前面
    const tight = budgetRefs(caps, { product: 10, style: 2, logo: true })
    expect(tight.style).toBe(0)
  })
})
