import ExcelJS from 'exceljs'
import { Listing, Product, Settings } from '../types'
import { buildPriceGrid, parseProductSizeCm, TIER_COUNT } from './pricing'

/**
 * GLS 产品表格导出（严格匹配 gls产品表格1014.xlsx「上传产品-1」sheet 结构）：
 * - 第 1 行：备注（红色说明）
 * - 第 2 行：分组表头（Basic details / Product attributes / Imprinting / List price / Upcharge）
 * - 第 3 行：主表头（PICTURE / Product Name / ... / Set-up Charge(G) / Sample Charge / 箱规 / 产品尺寸）
 * - 第 4 行：子表头（L / W / H / 长 / 宽 / 高 / 数量 / 链接 / 毛重 / 单价 / 起订数）
 * - 第 5 行起：产品数据
 * - 最右侧 cm 录入列（BO-BZ）+ 公式自动换算左侧英寸/磅列（K/L/M/N/O/R/S/T）
 * - 表头一字不改；默认值按用户规范填入
 */

// —— gls 表格默认值（用户规范）——
export const GLS_DEFAULTS = {
  itemPackaging: 'POLY BAG, BULK,Gift box',
  imprintingColors: 'PMS',
  productionTime: 7,
  rushService: 5,
  imprintingLocation: 'Front or as your request',
  canOrderLessThanMinimum: 'yes',
  priceIncludes: '1 color 1 location imprinted',
  setupCharge: 30,
  sampleCharge: 30,
} as const

/** 第 3 行主表头（列号 → 文本），一字不改 */
const HEADER_ROW3: Record<number, string> = {
  2: 'PICTURE',
  3: 'Product Name',
  4: 'Full Descrip',
  5: 'Type of Product',
  6: 'Product Number',
  7: 'Summary Descriptiontion',
  8: 'Categories',
  9: 'Product Keywords',
  10: 'Theme',
  11: 'PCS/CTN',
  12: 'Shipping Dimensions',
  13: 'Shipping Dimensions',
  14: 'Shipping Dimensions',
  15: 'Shipping Weight（lbs）',
  16: 'Item Packaging',
  17: 'Product Colors',
  18: 'Product Size',
  19: 'Product Size',
  20: 'Product Size',
  21: 'Product Materials',
  22: 'Unit Weight',
  23: 'Imprinting Methods',
  24: 'Imprinting Colors',
  25: 'Production Time',
  26: 'Rush Service Offered',
  27: 'Imprinting Size',
  28: 'Imprinting Location',
  29: 'Can order less than minimum',
  30: 'price Includes',
  // 31-38: Qty 1-8
  // 39-46: Net price1-8
  47: 'Set-up Charge(G)',
  48: 'Sample Charge',
  // 最右 cm 录入区
  67: '箱规',
  68: '箱规',
  69: '箱规',
  76: '产品尺寸',
  77: '产品尺寸',
  78: '产品尺寸',
}

/** 第 4 行子表头 */
const HEADER_ROW4: Record<number, string> = {
  2: 'PICTURE',
  3: 'Product Name',
  4: 'Full Descrip',
  5: 'Type of Product',
  6: 'Product Number',
  7: 'Summary Descriptiontion',
  8: 'Categories',
  9: 'Product Keywords',
  10: 'Theme',
  11: 'PCS/CTN',
  12: 'L',
  13: 'W',
  14: 'H',
  15: 'Shipping Weight（lbs）',
  16: 'Item Packaging',
  17: 'Product Colors',
  18: 'L',
  19: 'W',
  20: 'H',
  21: 'Product Materials',
  22: 'Unit Weight',
  23: 'Imprinting Methods',
  24: 'Imprinting Colors',
  25: 'Production Time',
  26: 'Rush Service Offered',
  27: 'Imprinting Size',
  28: 'Imprinting Location',
  29: 'Can order less than minimum',
  30: 'price Includes',
  31: 'Qty 1',
  32: 'Qty 2',
  33: 'Qty 3',
  34: 'Qty 4',
  35: 'Qty 5',
  36: 'Qty 6',
  37: 'Qty 7',
  38: 'Qty 8',
  39: 'Net price1',
  40: 'Net price2',
  41: 'Net price3',
  42: 'Net price4',
  43: 'Net price5',
  44: 'Net price6',
  45: 'Net price7',
  46: 'Net price8',
  47: 'Set-up Charge(G)',
  48: 'Sample Charge',
  67: '长',
  68: '宽',
  69: '高',
  70: '数量',
  71: '链接',
  72: '毛重',
  73: '单价',
  74: '起订数',
  76: '长',
  77: '宽',
  78: '高',
}

/** 第 2 行分组表头 */
const HEADER_ROW2: Record<number, string> = {
  3: 'Basic details',
  4: 'Basic details',
  5: 'Basic details',
  6: 'Basic details',
  7: 'Basic details',
  8: 'Basic details',
  9: 'Basic details',
  10: 'Basic details',
  11: 'Basic details',
  12: 'Basic details',
  13: 'Basic details',
  14: 'Basic details',
  15: 'Basic details',
  16: 'Basic details',
  17: 'Product attributes',
  18: 'Product attributes',
  19: 'Product attributes',
  20: 'Product attributes',
  21: 'Product attributes',
  22: 'Product attributes',
  23: 'Imprinting',
  24: 'Imprinting',
  25: 'Imprinting',
  26: 'Imprinting',
  27: 'Imprinting',
  28: 'Imprinting',
  31: 'List price 代码使用C,制版费代码G*',
  32: 'List price 代码使用C,制版费代码G*',
  33: 'List price 代码使用C,制版费代码G*',
  34: 'List price 代码使用C,制版费代码G*',
  35: 'List price 代码使用C,制版费代码G*',
  36: 'List price 代码使用C,制版费代码G*',
  37: 'List price 代码使用C,制版费代码G*',
  38: 'List price 代码使用C,制版费代码G*',
  39: 'List price 代码使用C,制版费代码G*',
  40: 'List price 代码使用C,制版费代码G*',
  41: 'List price 代码使用C,制版费代码G*',
  42: 'List price 代码使用C,制版费代码G*',
  43: 'List price 代码使用C,制版费代码G*',
  47: 'Upcharge附加费用',
  48: 'Upcharge附加费用',
}

const NOTE_ROW1 =
  '备注\n1. *为必填项，其他为选填项(详细更好)，请注意红色字体说明（凡有字符限制的，超过字符数系统自动删除）（选填项没有的话上传产品时默认不输入）\n2. 所有单元格必须为英文输入法下输入的文字，字符，不能出现中文字符\n3. 不要在单元格里加公式\n4. 计量单位为美国单位，如英尺，英寸，华氏度，磅等\n5. 标题，关键词，描述，概要等必须以字母数字字符开头；均不能侵权，如不能出现别人的商标名，品牌名，如3M，Disney等；不能使用除$#&%/- 之外的任何符号；不能包含网址URL；'

/** Excel 列号（1-based）→ 字母 */
export function colLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// 关键列号常量
const COL = {
  picture: 2, // B
  productName: 3, // C
  fullDescrip: 4, // D
  typeOfProduct: 5, // E
  productNumber: 6, // F
  summary: 7, // G
  categories: 8, // H
  keywords: 9, // I
  theme: 10, // J
  pcsPerCtn: 11, // K  = 数量(BR)
  shipL: 12, // L  = 箱规长(BO)/2.54
  shipW: 13, // M  = 箱规宽(BP)/2.54
  shipH: 14, // N  = 箱规高(BQ)/2.54
  shipWeight: 15, // O  = CONVERT(毛重BT,"kg","lbm")
  itemPackaging: 16, // P
  colors: 17, // Q
  sizeL: 18, // R  = 产品尺寸长(BX)/2.54
  sizeW: 19, // S  = 产品尺寸宽(BY)/2.54
  sizeH: 20, // T  = 产品尺寸高(BZ)/2.54
  materials: 21, // U
  unitWeight: 22, // V
  imprintMethods: 23, // W
  imprintColors: 24, // X
  productionTime: 25, // Y
  rushService: 26, // Z
  imprintSize: 27, // AA
  imprintLocation: 28, // AB
  lessThanMin: 29, // AC
  priceIncludes: 30, // AD
  qty1: 31, // AE-AF-...-AL (Qty1-8)
  price1: 39, // AM-AT (Net price1-8)
  setupCharge: 47, // AU
  sampleCharge: 48, // AV
  // 最右 cm 录入区
  cartonLCm: 67, // BO
  cartonWCm: 68, // BP
  cartonHCm: 69, // BQ
  qtyCn: 70, // BR（每箱数量）
  link: 71, // BS（1688 链接）
  cartonGwKg: 72, // BT（毛重 kg）
  unitPriceCny: 73, // BU（单价 元）
  moq: 74, // BV（起订数）
  prodLCm: 76, // BX
  prodWCm: 77, // BY
  prodHCm: 78, // BZ
} as const

export interface GlsExportOptions {
  products: Product[]
  settings: Settings
  /** 产品编号前缀（Product Number 生成用），默认 GLS */
  numberPrefix?: string
}

/** 构建严格匹配 gls 表格的 Workbook */
export function buildGlsWorkbook(options: GlsExportOptions): ExcelJS.Workbook {
  const { products, settings, numberPrefix = 'GLS' } = options
  const wb = new ExcelJS.Workbook()
  wb.creator = 'ASI Workbench'
  wb.created = new Date()
  const ws = wb.addWorksheet('上传产品-1', {
    views: [{ state: 'frozen', ySplit: 4 }],
  })

  // 列宽（参考原表）
  const widths: Record<number, number> = {
    2: 18, 3: 32, 4: 60, 5: 16, 6: 12, 7: 40, 8: 24, 9: 50, 10: 18,
    11: 9, 12: 10, 13: 10, 14: 10, 15: 12, 16: 16, 17: 24, 18: 10, 19: 10, 20: 10,
    21: 20, 22: 10, 23: 28, 24: 12, 25: 12, 26: 12, 27: 16, 28: 16, 29: 12, 30: 20,
    47: 10, 48: 10,
    67: 8, 68: 8, 69: 8, 70: 8, 71: 30, 72: 8, 73: 8, 74: 8,
    76: 8, 77: 8, 78: 8,
  }
  for (let c = 1; c <= 78; c++) {
    ws.getColumn(c).width = widths[c] ?? (c >= 31 && c <= 46 ? 9 : 10)
  }

  // —— 第 1 行：备注 ——
  for (let c = 3; c <= 49; c++) {
    ws.getCell(1, c).value = NOTE_ROW1
  }

  // —— 第 2/3/4 行表头 ——
  for (const [c, text] of Object.entries(HEADER_ROW2)) {
    ws.getCell(2, Number(c)).value = text
  }
  for (const [c, text] of Object.entries(HEADER_ROW3)) {
    ws.getCell(3, Number(c)).value = text
  }
  for (const [c, text] of Object.entries(HEADER_ROW4)) {
    ws.getCell(4, Number(c)).value = text
  }
  // Qty/Net price 表头（第 3 行）
  for (let i = 0; i < TIER_COUNT; i++) {
    ws.getCell(3, COL.qty1 + i).value = `Qty ${i + 1}`
    ws.getCell(3, COL.price1 + i).value = `Net price${i + 1}`
  }
  // 表头样式
  for (const rn of [2, 3, 4]) {
    const row = ws.getRow(rn)
    row.font = { bold: true, size: 10 }
    row.alignment = { vertical: 'middle', wrapText: true }
    row.height = rn === 3 ? 42 : 20
  }
  ws.getRow(1).height = 90
  ws.getRow(1).font = { color: { argb: 'FFCC0000' }, size: 9 }
  ws.getRow(1).alignment = { wrapText: true, vertical: 'top' }

  // —— 数据行 ——
  let r = 5
  let seq = 1
  for (const p of products) {
    const l: Listing | null = p.listing
    const grid = l?.priceGrid?.length ? l.priceGrid : buildPriceGrid(p.source, settings).rows
    const prodCm = l?.productSizeCm ?? parseProductSizeCm(p.source.sizeCn, p.source.weightG)
    const row = ws.getRow(r)
    const A = (c: number) => `${colLetter(c)}${r}`

    // B: PICTURE（图片链接，多个用换行）
    const imgs = (p.source.images ?? []).filter(Boolean)
    if (imgs.length) row.getCell(COL.picture).value = imgs.join('\n')

    // C: Product Name（≤60 字符）
    row.getCell(COL.productName).value = (l?.title || p.source.sourceTitle || '').slice(0, 60)

    // D: Full Descrip（≤800 字符）
    row.getCell(COL.fullDescrip).value = (l?.description || '').slice(0, 800)

    // E: Type of Product（ASI 一级大类，单选；优先专用字段，回退主类目）
    row.getCell(COL.typeOfProduct).value = l?.typeOfProduct || l?.category || p.source.category || 'Other'

    // F: Product Number（前缀+序号）
    row.getCell(COL.productNumber).value = `${numberPrefix}${String(seq).padStart(3, '0')}`

    // G: Summary Description（≤130，Rush 结尾）
    row.getCell(COL.summary).value = (l?.summary || '').slice(0, 130)

    // H: Categories（最多 2 个，换行分隔）
    const cats = (l?.categories?.length ? l.categories : [l?.category].filter(Boolean)).slice(0, 2)
    if (cats.length) row.getCell(COL.categories).value = cats.join('\n')

    // I: Product Keywords（逗号分隔）
    row.getCell(COL.keywords).value = (l?.keywords ?? []).join(',')

    // J: Theme（换行分隔 5 个）
    row.getCell(COL.theme).value = (l?.themes ?? []).join('\n')

    // K: PCS/CTN = 数量(BR)
    row.getCell(COL.pcsPerCtn).value = { formula: A(COL.qtyCn) }

    // L/M/N: Shipping Dimensions = 箱规 cm / 2.54
    row.getCell(COL.shipL).value = { formula: `${A(COL.cartonLCm)}/2.54` }
    row.getCell(COL.shipW).value = { formula: `${A(COL.cartonWCm)}/2.54` }
    row.getCell(COL.shipH).value = { formula: `${A(COL.cartonHCm)}/2.54` }

    // O: Shipping Weight = CONVERT(毛重kg,"kg","lbm")
    row.getCell(COL.shipWeight).value = { formula: `CONVERT(${A(COL.cartonGwKg)},"kg","lbm")` }

    // P: Item Packaging（默认）
    row.getCell(COL.itemPackaging).value = GLS_DEFAULTS.itemPackaging

    // Q: Product Colors
    row.getCell(COL.colors).value = l?.colors || ''

    // R/S/T: Product Size = 产品尺寸 cm / 2.54
    row.getCell(COL.sizeL).value = { formula: `${A(COL.prodLCm)}/2.54` }
    row.getCell(COL.sizeW).value = { formula: `${A(COL.prodWCm)}/2.54` }
    row.getCell(COL.sizeH).value = { formula: `${A(COL.prodHCm)}/2.54` }

    // U: Product Materials
    const materials = l?.materials?.length ? l.materials : l?.material ? [l.material] : []
    row.getCell(COL.materials).value = materials.join(',')

    // V: Unit Weight（磅）= 产品克重 / 453.592
    if (p.source.weightG) {
      row.getCell(COL.unitWeight).value = {
        formula: `ROUND(${p.source.weightG}/453.592,3)`,
      }
    }

    // W: Imprinting Methods
    row.getCell(COL.imprintMethods).value = (l?.imprintMethods ?? []).join('/')

    // X: Imprinting Colors（默认 PMS）
    row.getCell(COL.imprintColors).value = GLS_DEFAULTS.imprintingColors

    // Y: Production Time（默认 7）
    row.getCell(COL.productionTime).value = GLS_DEFAULTS.productionTime

    // Z: Rush Service Offered（默认 5）
    row.getCell(COL.rushService).value = GLS_DEFAULTS.rushService

    // AA: Imprinting Size
    row.getCell(COL.imprintSize).value = l?.imprintArea || ''

    // AB: Imprinting Location（默认）
    row.getCell(COL.imprintLocation).value = GLS_DEFAULTS.imprintingLocation

    // AC: Can order less than minimum（默认 yes）
    row.getCell(COL.lessThanMin).value = GLS_DEFAULTS.canOrderLessThanMinimum

    // AD: price Includes（默认）
    row.getCell(COL.priceIncludes).value = GLS_DEFAULTS.priceIncludes

    // AE-AL: Qty 1-8；AM-AT: Net price1-8
    for (let i = 0; i < TIER_COUNT; i++) {
      const hit = grid[i]
      row.getCell(COL.qty1 + i).value = hit ? hit.qty : null
      row.getCell(COL.price1 + i).value = hit ? Number(hit.unitPrice.toFixed(2)) : null
    }

    // AU/AV: Set-up Charge / Sample Charge（默认 30/30）
    row.getCell(COL.setupCharge).value = GLS_DEFAULTS.setupCharge
    row.getCell(COL.sampleCharge).value = GLS_DEFAULTS.sampleCharge

    // —— 最右 cm 录入区 ——
    row.getCell(COL.cartonLCm).value = p.source.cartonLCm ?? null
    row.getCell(COL.cartonWCm).value = p.source.cartonWCm ?? null
    row.getCell(COL.cartonHCm).value = p.source.cartonHCm ?? null
    row.getCell(COL.qtyCn).value = p.source.pcsPerCarton ?? null
    if (p.source.sourceUrl) {
      const linkCell = row.getCell(COL.link)
      linkCell.value = { text: p.source.sourceUrl, hyperlink: p.source.sourceUrl }
      linkCell.font = { color: { argb: 'FF0563C1' }, underline: true }
    }
    row.getCell(COL.cartonGwKg).value = p.source.cartonGwKg ?? null
    row.getCell(COL.unitPriceCny).value = p.source.priceCny ?? null
    row.getCell(COL.moq).value = p.source.moq ?? null
    row.getCell(COL.prodLCm).value = prodCm?.l ?? null
    row.getCell(COL.prodWCm).value = prodCm?.w ?? null
    row.getCell(COL.prodHCm).value = prodCm?.h ?? null

    // 数据行样式
    row.alignment = { vertical: 'top', wrapText: true }
    row.font = { size: 10 }
    r++
    seq++
  }

  return wb
}
