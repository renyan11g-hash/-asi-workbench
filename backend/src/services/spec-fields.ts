/**
 * 产品结构化资料的「纯逻辑」：字段定义、清洗、完整性判定、提示词片段、指纹。
 *
 * 单独一个文件的原因：这里全是纯函数，不连数据库、不调模型，
 * 所以能被单元测试直接覆盖（批量生产最关键的就是「不许编造」这一条，必须有测试守着）。
 * 需要落库/调模型的部分在 product-specs.ts。
 */

import { createHash } from 'crypto'
import type { ProductSpecs, SourceInfo } from '../types'

/** Unknown 的唯一写法：界面判断、导出、质量检查都认这一个值 */
export const UNKNOWN = 'Unknown'

export interface SpecFieldDef {
  key: keyof ProductSpecs
  /** 中文标签（界面/Excel 用） */
  label: string
  /** 英文标签（注入 Listing 提示词用） */
  labelEn: string
  hint: string
}

/** 14 个标准字段 —— 顺序就是界面上的顺序，也是提示词里的顺序 */
export const SPEC_FIELDS: SpecFieldDef[] = [
  { key: 'productName', label: '产品名称', labelEn: 'Product Name', hint: '1688 商品名，去掉店铺广告语' },
  { key: 'material', label: '材质', labelEn: 'Material', hint: '如 304 不锈钢 + PP 塑料' },
  { key: 'productSize', label: '产品尺寸', labelEn: 'Product Size', hint: '单个产品尺寸，保留原始单位' },
  { key: 'productWeight', label: '产品净重', labelEn: 'Product Weight', hint: '单件净重，如 120g' },
  { key: 'colors', label: '可选颜色', labelEn: 'Available Colors', hint: '可提供的颜色清单' },
  { key: 'specifications', label: '产品规格', labelEn: 'Specifications', hint: '容量/型号/规格档位' },
  { key: 'functions', label: '产品功能', labelEn: 'Functions', hint: '这个东西是用来做什么的' },
  { key: 'features', label: '产品特点', labelEn: 'Features', hint: '卖点：防漏、便携、可折叠…' },
  { key: 'logoCustomization', label: 'LOGO 定制情况', labelEn: 'Logo Customization', hint: '能否定制、可用什么工艺、位置' },
  { key: 'packaging', label: '包装信息', labelEn: 'Packaging', hint: '单件包装：opp 袋 / 彩盒 / 白盒' },
  { key: 'cartonDimensions', label: '外箱尺寸', labelEn: 'Carton Dimensions', hint: '外箱长宽高' },
  { key: 'unitsPerCarton', label: '每箱数量', labelEn: 'Units Per Carton', hint: '装箱数量' },
  { key: 'cartonGrossWeight', label: '外箱毛重', labelEn: 'Carton Gross Weight', hint: '整箱毛重' },
  { key: 'application', label: '使用场景', labelEn: 'Application', hint: '办公室 / 户外 / 礼品…' },
]

export const SPEC_KEYS = SPEC_FIELDS.map((f) => f.key) as Array<keyof ProductSpecs>

export function emptySpecs(): ProductSpecs {
  return SPEC_KEYS.reduce((acc, k) => {
    acc[k] = UNKNOWN
    return acc
  }, {} as ProductSpecs)
}

/** 这个值算「确实有资料」吗（Unknown / 空 / N/A 都算没有） */
export function isKnown(v: unknown): boolean {
  const s = String(v ?? '').trim()
  if (!s) return false
  const low = s.toLowerCase()
  return !['unknown', 'n/a', 'na', 'none', 'null', '-', '—', '未知', '不详'].includes(low)
}

/** 清洗单个值：合并空白、去引号、压到 500 字以内（避免把整篇详情塞进一个字段） */
export function cleanValue(v: unknown): string {
  let s = String(v ?? '').trim()
  if (!s) return UNKNOWN
  s = s
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s || !isKnown(s)) return UNKNOWN
  return s.length > 500 ? `${s.slice(0, 497)}…` : s
}

/** 把 AI 返回的任意对象规整成 14 字段（缺的补 Unknown，多的一律丢弃） */
export function normalizeSpecs(raw: unknown): {
  specs: ProductSpecs
  unknownFields: string[]
  filled: number
} {
  const src = (raw ?? {}) as Record<string, unknown>
  const specs = emptySpecs()
  for (const key of SPEC_KEYS) {
    specs[key] = cleanValue(src[key])
  }
  const unknownFields = SPEC_KEYS.filter((k) => !isKnown(specs[k])) as string[]
  return { specs, unknownFields, filled: SPEC_KEYS.length - unknownFields.length }
}

/** 原始资料的指纹：用来判断「资料改过没有，要不要重新提取」 */
export function specsSourceHash(source: SourceInfo): string {
  const payload = [
    source.sourceTitle,
    source.description,
    source.materialCn,
    source.colorsCn,
    source.sizeCn,
    source.weightG,
    source.cartonLCm,
    source.cartonWCm,
    source.cartonHCm,
    source.pcsPerCarton,
    source.cartonGwKg,
    source.notes,
    source.category,
  ].join('|')
  return createHash('sha1').update(payload).digest('hex').slice(0, 16)
}

/** 注入 Listing 提示词的结构化资料块（未知字段不出现，避免模型把 Unknown 当事实） */
export function specsToPromptBlock(specs: ProductSpecs | null | undefined): string {
  if (!specs) return ''
  const lines = SPEC_FIELDS.filter((f) => isKnown(specs[f.key])).map(
    (f) => `- ${f.labelEn}: ${String(specs[f.key]).trim()}`
  )
  if (!lines.length) return ''
  return `\n\nSTRUCTURED PRODUCT DATA (verified fact sheet for THIS product — Chinese values, translate faithfully; these are the same facts as the 1688 source, just organized):
${lines.join('\n')}

RULES FOR USING THIS FACT SHEET:
1. Every number, material, size, weight, capacity, packaging detail you write must appear above or in the 1688 source. Never add one that is absent.
2. If a fact is missing here, do NOT invent it — write the copy without that specific claim.
3. Translate the Chinese values into natural US promo English; keep model numbers, materials (304 stainless steel, PP, PU) and units accurate.`
}
