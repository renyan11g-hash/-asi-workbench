/**
 * 读取 gls产品表格1014.xlsx，输出表头结构、默认值、公式，用于后端导出功能对齐
 */
import ExcelJS from 'exceljs'

const file = process.argv[2] || 'c:/Users/Administrator/Desktop/gls产品表格/gls产品表格1014.xlsx'

const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(file)

wb.eachSheet((ws) => {
  console.log(`\n===== Sheet: ${ws.name} (rows=${ws.rowCount}, cols=${ws.columnCount}) =====`)
  // 打印前 3 行（表头 + 示例数据），包含公式
  for (let r = 1; r <= Math.min(3, ws.rowCount); r++) {
    const row = ws.getRow(r)
    console.log(`--- Row ${r} ---`)
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const parts = []
      if (cell.formula) parts.push(`formula=${cell.formula}`)
      if (cell.value !== null && cell.value !== undefined && !cell.formula) {
        parts.push(`value=${JSON.stringify(cell.value)}`)
      }
      if (parts.length) {
        console.log(`  [${colNumber}] ${cell.address}: ${parts.join(' | ')}`)
      }
    })
  }
})
