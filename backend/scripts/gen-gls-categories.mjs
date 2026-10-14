// 从提取的类目 JSON 生成 src/constants/gls-categories.ts
import fs from 'fs'

const raw = JSON.parse(fs.readFileSync('scripts/categories-extracted.json', 'utf8'))
const seen = new Set()
const out = []
for (let s of raw) {
  if (typeof s !== 'string') continue
  s = s.trim()
  if (!s) continue
  // 过滤垃圾条目：过长 / 含中文 / 含句号说明文字
  if (s.length > 60) continue
  if (/[\u4e00-\u9fff]/.test(s)) continue
  if (/[.。;；]/.test(s)) continue
  const key = s.toUpperCase()
  if (seen.has(key)) continue
  seen.add(key)
  out.push(s)
}
out.sort((a, b) => a.localeCompare(b, 'en'))

const body = out.map((s) => `  ${JSON.stringify(s)},`).join('\n')
const ts = `/**
 * GLS 产品表格 Categories 参考表（${out.length} 项，提取自 gls产品表格1014.xlsx 的 Categories sheet）。
 * 产品类目（H 列）必须从此列表中选择，最多 2 个。
 */
export const GLS_CATEGORIES = [
${body}
] as const

export type GlsCategory = (typeof GLS_CATEGORIES)[number]
`
fs.writeFileSync('src/constants/gls-categories.ts', ts)
console.log(`written ${out.length} categories`)
