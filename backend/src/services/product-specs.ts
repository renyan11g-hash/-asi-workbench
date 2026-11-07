/**
 * 产品资料结构化（批量生产系统 V1 · 第一阶段）。
 *
 * 解决的问题：1688 抓回来的是「一坨自由文本」（标题 + 详情 + 几个字段），
 * 每生成一次文案都要重新读一遍，AI 每次理解还可能不一样。
 * 这里把它整理成固定的 14 个字段，存一份；之后生成 Listing、做质量检查都以这一份为准。
 *
 * 三条硬规矩（用户明确要求）：
 *   ① 不许编造：资料里没写的，值就是字符串 Unknown。
 *   ② 不许覆盖原始资料：结构化结果单独一张表，products 里的原文一个字节都不动。
 *   ③ 可以人工改：改过的记录 edited_at，重新提取时默认保留人工值（除非用户明确要求覆写）。
 */

import { db } from '../db'
import type { ProductSpecs, ProductSpecRecord, Settings, SourceInfo } from '../types'
import { callChatJsonDetailed } from './ai'
import { SPEC_KEYS, normalizeSpecs, specsSourceHash } from './spec-fields'

// 纯逻辑（字段定义/清洗/完整性/提示词片段/指纹）都在 spec-fields.ts，这里统一再导出，
// 让调用方只 import 一个文件也能拿到全部。
export * from './spec-fields'


// ---------------------------------------------------------------- 提取

function buildExtractPrompt(source: SourceInfo): { system: string; user: string } {
  const system = `You extract structured product data for a Chinese promotional-products sourcing workflow.

ABSOLUTE RULES:
1. Use ONLY facts explicitly present in the material below. The material is in Chinese; keep your answers in Chinese.
2. If a field is not stated in the material, output exactly the string "Unknown". NEVER guess, infer from the product type, or fill a plausible value.
3. NEVER invent certifications, materials, dimensions, capacities, weights, packaging, or logo capability.
4. Keep the original units and numbers as written (do not convert cm to inch, g to oz, or rename models).
5. Copy values, do not market them: no adjectives like "high quality", no sales copy, no translations to English.
6. One field = one short phrase. Max 60 Chinese characters per field. If the material is long, keep only what answers that field.
7. If the material contains a value list (e.g. several colors or sizes), join with "、" keeping the same order.
8. Output STRICT JSON only — no markdown, no code fences, no commentary.

Output JSON with exactly these 14 keys (all strings):
{
  "productName": "产品名称（1688 商品名，去掉店铺广告语）",
  "material": "材质，如 304不锈钢+PP",
  "productSize": "单个产品尺寸，保留原始单位",
  "productWeight": "单件净重，保留原始单位",
  "colors": "可选颜色清单",
  "specifications": "规格/容量/型号",
  "functions": "产品功能（做什么用）",
  "features": "产品特点（防漏/便携/可折叠等）",
  "logoCustomization": "LOGO 定制情况（能否定制、工艺、位置）",
  "packaging": "单件包装方式",
  "cartonDimensions": "外箱尺寸",
  "unitsPerCarton": "每箱数量",
  "cartonGrossWeight": "外箱毛重",
  "application": "使用场景"
}`

  const carton =
    source.cartonLCm || source.cartonWCm || source.cartonHCm
      ? `${source.cartonLCm ?? '?'} x ${source.cartonWCm ?? '?'} x ${source.cartonHCm ?? '?'} cm`
      : 'Unknown'

  const user = `MATERIAL TO EXTRACT FROM (1688 product):

- Title: ${source.sourceTitle || '(empty)'}
- Category hint: ${source.category || '(empty)'}
- 1688 keywords/tags: ${(source.sourceKeywords ?? []).join('、') || '(empty)'}
- Material field (Chinese): ${source.materialCn || '(empty)'}
- Colors field (Chinese): ${source.colorsCn || '(empty)'}
- Size field (Chinese): ${source.sizeCn || '(empty)'}
- Unit weight (g): ${source.weightG ?? '(empty)'}
- Carton: ${carton}
- Units per carton: ${source.pcsPerCarton ?? '(empty)'}
- Carton gross weight (kg): ${source.cartonGwKg ?? '(empty)'}
- Buyer/salesperson notes: ${source.notes || '(empty)'}
- Full detailed description (may be long, may contain a spec table):
${(source.description || '(empty)').slice(0, 6000)}

Extract the 14 fields. Anything not explicitly stated above must be "Unknown".`

  return { system, user }
}

export interface ExtractResult {
  specs: ProductSpecs
  unknownFields: string[]
  filled: number
  model: string
  durationMs: number
}

/**
 * 调模型提取 14 字段。
 * 没有配置 AI Key 时直接抛错（不返回一份假数据）—— 由调用方决定要不要降级成「人工填写」。
 */
export async function extractSpecs(
  source: SourceInfo,
  settings: Settings,
  productId?: string | null
): Promise<ExtractResult> {
  const { system, user } = buildExtractPrompt(source)
  const { data, model, durationMs } = await callChatJsonDetailed<Record<string, unknown>>(
    settings,
    system,
    user,
    0.1,
    undefined,
    { task: 'spec-extract', productId }
  )
  const { specs, unknownFields, filled } = normalizeSpecs(data)
  return { specs, unknownFields, filled, model, durationMs }
}


// ---------------------------------------------------------------- 落库

interface SpecRow {
  product_id: string
  data: string
  unknown_fields: string
  source_hash: string
  model: string
  extracted_at: string | null
  edited_at: string | null
  created_at: string
  updated_at: string
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

function rowToRecord(r: SpecRow): ProductSpecRecord {
  const { specs, unknownFields, filled } = normalizeSpecs(parseJson<unknown>(r.data, {}))
  return {
    productId: r.product_id,
    specs,
    unknownFields,
    filled,
    total: SPEC_KEYS.length,
    model: r.model ?? '',
    sourceHash: r.source_hash ?? '',
    extractedAt: r.extracted_at,
    editedAt: r.edited_at,
    updatedAt: r.updated_at,
  }
}

export function getSpecRecord(productId: string): ProductSpecRecord | null {
  try {
    const row = db.prepare('SELECT * FROM product_specs WHERE product_id = ?').get(productId) as
      | unknown
      | SpecRow
      | undefined
    return row ? rowToRecord(row as SpecRow) : null
  } catch {
    return null
  }
}

export function listSpecRecords(productIds: string[]): Map<string, ProductSpecRecord> {
  const out = new Map<string, ProductSpecRecord>()
  if (!productIds.length) return out
  try {
    const placeholders = productIds.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT * FROM product_specs WHERE product_id IN (${placeholders})`)
      .all(...productIds) as unknown as SpecRow[]
    for (const r of rows) out.set(r.product_id, rowToRecord(r))
  } catch {
    /* 表还没建好时当作全都没有 */
  }
  return out
}

/** 存一份结构化资料（存在则更新；created_at 保留首次时间） */
export function saveSpecs(
  productId: string,
  specs: ProductSpecs,
  opts?: { model?: string; sourceHash?: string; extracted?: boolean; edited?: boolean }
): ProductSpecRecord {
  const now = new Date().toISOString()
  const { unknownFields } = normalizeSpecs(specs)
  const existing = getSpecRecord(productId)
  const raw = limitValues(specs)
  // 人工改字段时不动指纹：指纹只代表「提取那一刻的原始资料」，用来提示过期
  const sourceHash = opts?.sourceHash ?? existing?.sourceHash ?? ''
  if (existing) {
    db.prepare(
      `UPDATE product_specs SET data=?, unknown_fields=?, source_hash=?, model=?, extracted_at=?, edited_at=?, updated_at=?
       WHERE product_id=?`
    ).run(
      JSON.stringify(raw),
      JSON.stringify(unknownFields),
      sourceHash,
      opts?.model ?? existing.model,
      opts?.extracted ? now : existing.extractedAt,
      opts?.edited ? now : existing.editedAt,
      now,
      productId
    )
  } else {
    db.prepare(
      `INSERT INTO product_specs
        (product_id, data, unknown_fields, source_hash, model, extracted_at, edited_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      productId,
      JSON.stringify(raw),
      JSON.stringify(unknownFields),
      sourceHash,
      opts?.model ?? '',
      opts?.extracted ? now : null,
      opts?.edited ? now : null,
      now,
      now
    )
  }
  return getSpecRecord(productId) as ProductSpecRecord
}

/** 入库前最后一道清洗（和 normalizeSpecs 同一套规则，但保留对象形状） */
function limitValues(specs: ProductSpecs): ProductSpecs {
  return normalizeSpecs(specs).specs
}

/** 删除产品的结构化资料（彻底删除产品时调用） */
export function deleteSpecs(productId: string): void {
  try {
    db.prepare('DELETE FROM product_specs WHERE product_id = ?').run(productId)
  } catch {
    /* ignore */
  }
}

/**
 * 人工改了资料后，是否需要「重新提取」的提醒：
 * 提取时记的指纹和现在的不一致 = 原始资料变了，结构化结果可能过期。
 */
export function specsStale(productId: string, source: SourceInfo): boolean {
  try {
    const row = db.prepare('SELECT source_hash FROM product_specs WHERE product_id = ?').get(productId) as
      | { source_hash: string }
      | undefined
    if (!row?.source_hash) return false
    return row.source_hash !== specsSourceHash(source)
  } catch {
    return false
  }
}
