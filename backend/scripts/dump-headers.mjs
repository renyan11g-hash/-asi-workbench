// 导出 gls 表格的完整表头（富文本全文）、sheet 列表、数据验证（下拉选项）
import ExcelJS from 'exceljs'

const file = process.argv[2] || 'c:\\Users\\Administrator\\Desktop\\gls产品表格\\gls产品表格1014.xlsx'
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(file)

console.log('===== Sheets =====')
wb.worksheets.forEach((ws) => console.log(`- ${ws.name} (rows=${ws.rowCount}, cols=${ws.columnCount})`))

const ws = wb.getWorksheet('上传产品-1')
if (!ws) {
  console.error('sheet not found')
  process.exit(1)
}

const cellText = (c) => {
  if (!c) return ''
  const v = c.value
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v.richText) return v.richText.map((rt) => rt.text).join('')
  if (v.text) return String(v.text)
  if (v.formula) return `=${v.formula}${v.result != null ? ` => ${v.result}` : ''}`
  if (v.error) return `<err:${v.error}>`
  return JSON.stringify(v).slice(0, 120)
}

for (const rn of [1, 2, 3, 4]) {
  const row = ws.getRow(rn)
  console.log(`\n===== Row ${rn} =====`)
  row.eachCell({ includeEmpty: false }, (c, cn) => {
    const t = cellText(c)
    if (t) console.log(`  ${c.address}: ${JSON.stringify(t)}`)
  })
}

console.log('\n===== Data Validations =====')
try {
  const dv = ws.dataValidations
  console.log(JSON.stringify(dv, null, 1).slice(0, 8000))
} catch (e) {
  console.log('no dv', e.message)
}
