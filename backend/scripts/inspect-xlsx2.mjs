/**
 * 精准提取关键 sheet 的表头、公式、示例数据（跳过 richText 长文本）
 */
import ExcelJS from 'exceljs'

const file = process.argv[2] || 'c:/Users/Administrator/Desktop/gls产品表格/gls产品表格1014.xlsx'
const targetSheets = process.argv[3] ? process.argv[3].split('|') : null

const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(file)

wb.eachSheet((ws) => {
  if (targetSheets && !targetSheets.includes(ws.name)) return
  console.log(`\n===== Sheet: ${ws.name} (rows=${ws.rowCount}, cols=${ws.columnCount}) =====`)
  const maxRow = Math.min(ws.rowCount, 12)
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r)
    const cells = []
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      let desc = ''
      if (cell.formula) {
        desc = `F:${cell.formula}`
        if (cell.result !== undefined && cell.result !== null) desc += ` => ${cell.result}`
      } else if (cell.value !== null && cell.value !== undefined) {
        const v = cell.value
        if (typeof v === 'object' && v !== null && 'richText' in v) {
          const rt = v.richText
          const text = rt.map((t) => t.text).join('').replace(/\n+/g, ' ').slice(0, 30)
          desc = `[RT]${text}`
        } else {
          desc = JSON.stringify(v)
        }
      }
      if (desc) {
        const s = desc.length > 160 ? desc.slice(0, 160) + '…' : desc
        cells.push(`${cell.address}=${s}`)
      }
    })
    if (cells.length) console.log(`R${r}: ${cells.join(' | ')}`)
  }
})
