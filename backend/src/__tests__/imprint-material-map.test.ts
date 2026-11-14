import { ASI_MATERIALS } from '../constants/asi'
import { normalizeAsiMaterial, recommendImprintMethods } from '../services/imprint-recommend'

/**
 * 2026-11-14 线上问题回归：英文链接页「印刷方式解读」材质识别不准、且改材质不跟着变。
 *
 * 根因一：ASI 材质清单 70 项，引擎只建了 28 个档案，其余（Polycarbonate / Brass / Suede…）
 *        全部掉进「材质未识别」，解读退化成通用兜底。
 * 根因二：前端把英文材质塞进 materialCn、也没有把 listing 的 materials 传成 materialEn，
 *        改材质后也不会重算。这里用单元测试守住第一层（后端映射）。
 */

const src = { materialCn: '', sourceTitle: '', description: '' }

describe('ASI 材质名 → 规则引擎档案', () => {
  it('ASI 材质清单里除 Other 外全部能归一（不留“未识别”死角）', () => {
    const missing = ASI_MATERIALS.filter((m) => m !== 'Other' && !normalizeAsiMaterial(m))
    expect(missing).toEqual([])
  })

  it('大小写不敏感，已有档案原样返回', () => {
    expect(normalizeAsiMaterial('stainless steel')).toBe('Stainless Steel')
    expect(normalizeAsiMaterial('Stainless Steel')).toBe('Stainless Steel')
  })

  it('别名映射到最接近的档案', () => {
    expect(normalizeAsiMaterial('Polycarbonate')).toBe('ABS')
    expect(normalizeAsiMaterial('Brass')).toBe('Metal')
    expect(normalizeAsiMaterial('Polyethylene (PE)')).toBe('PE')
    expect(normalizeAsiMaterial('Suede')).toBe('Leather')
    expect(normalizeAsiMaterial('Other')).toBeNull()
  })
})

describe('推荐引擎按业务员选的材质出结论', () => {
  it('Polycarbonate 应该是硬塑，不再是「材质未识别」', () => {
    const r = recommendImprintMethods(src, ['Polycarbonate'])
    expect(r.materialDetected).toBe(true)
    expect(r.families).toContain('硬塑')
    expect(r.inputMaterials).toEqual(['Polycarbonate'])
    expect(r.unmappedMaterials).toEqual([])
    // 硬塑首选丝印/移印这类，不应该只剩兜底那四条
    const methods = r.recommendations.filter((x) => !x.required).map((x) => x.method)
    expect(methods.length).toBeGreaterThan(4)
  })

  it('换成不锈钢后，工艺结论跟着材质变（激光雕刻进入首选）', () => {
    const plastic = recommendImprintMethods(src, ['Polycarbonate'])
    const metal = recommendImprintMethods(src, ['Stainless Steel'])
    const laserIn = (r: typeof plastic) =>
      r.recommendations.some((x) => x.method === 'Laser Engraved' && x.tier === 'primary')
    expect(metal.families).toContain('金属')
    expect(laserIn(metal)).toBe(true)
    expect(laserIn(plastic)).toBe(false)
  })

  it('Other 保持未识别，并明确告诉上层是哪个材质没覆盖', () => {
    const r = recommendImprintMethods(src, ['Other'])
    expect(r.materialDetected).toBe(false)
    expect(r.unmappedMaterials).toEqual(['Other'])
  })
})
