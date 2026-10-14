// 导出 Type of Product / Item Packaging / Imprint Method 等参考 sheet 的完整内容
import ExcelJS from 'exceljs'

const file = process.argv[2] || 'c:\\Users\\Administrator\\Desktop\\gls产品表格\\gls产品表格1014.xlsx'
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(file)

const cellText = (c) => {
  if (!c) return ''
  const v = c.value
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v.richText) return v.richText.map((rt) => rt.text).join('')
  if (v.text) return String(v.text)
  if (v.formula) return `=${v.formula}`
  return ''
}

for (const name of ['ASI上传选择类', 'Item Packaging', 'Imprint Method', 'Themes']) {
  const ws = wb.getWorksheet(name)
  if (!ws) continue
  console.log(`\n===== Sheet: ${name} =====`)
  for (let rn = 1; rn <= Math.min(ws.rowCount, 60); rn++) {
    const row = ws.getRow(rn)
    const vals = []
    row.eachCell({ includeEmpty: false }, (c, cn) => {
      const t = cellText(c).trim()
      if (t) vals.push(`${c.address}=${t.slice(0, 80)}`)
    })
    if (vals.length) console.log(`R${rn}: ${vals.join(' | ')}`)
  }
}
