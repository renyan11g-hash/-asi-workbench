/**
 * 提取 gls产品表格1014.xlsx 的 Categories sheet 全部分类（英文名），输出去重列表
 */
import ExcelJS from 'exceljs'
import fs from 'fs'

const file = process.argv[2] || 'c:/Users/Administrator/Desktop/gls产品表格/gls产品表格1014.xlsx'

const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(file)
const ws = wb.getWorksheet('Categories')
if (!ws) {
  console.error('Categories sheet not found')
  process.exit(1)
}

const seen = new Set()
const list = []
ws.eachRow((row, rowNumber) => {
  if (rowNumber === 1) return // 表头（A开头产品/翻译…）
  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const v = cell.value
    let text = ''
    if (typeof v === 'string') text = v
    else if (v && typeof v === 'object' && 'richText' in v) {
      text = v.richText.map((t) => t.text).join('')
    } else if (v && typeof v === 'object' && 'text' in v) {
      text = String(v.text)
    }
    text = text.trim()
    // 只要英文分类（含字母，且不含中文）
    if (!text) return
    if (/[\u4e00-\u9fa5]/.test(text)) return
    if (!/[A-Za-z]/.test(text)) return
    const key = text.toUpperCase()
    if (seen.has(key)) return
    seen.add(key)
    list.push(text)
  })
})

list.sort((a, b) => a.localeCompare(b))
fs.writeFileSync('scripts/categories-extracted.json', JSON.stringify(list, null, 2))
console.log(`共提取 ${list.length} 个分类，已写入 scripts/categories-extracted.json`)
console.log(list.slice(0, 20).join(' | '))
