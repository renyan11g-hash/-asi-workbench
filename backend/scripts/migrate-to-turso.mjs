/**
 * 本地 SQLite → Turso 数据迁移脚本
 *
 * 用法（在 backend 目录下）：
 *   1. 设置环境变量：
 *      set LIBSQL_URL=libsql://你的数据库名-你的组织.turso.io
 *      set LIBSQL_AUTH_TOKEN=你的token
 *   2. 运行：
 *      node scripts/migrate-to-turso.mjs [本地db文件路径]
 *      （默认读取 ../data/asi-workbench.db，即 Desktop/backend/data）
 *
 * 幂等：使用 INSERT OR REPLACE，可重复执行不会产生重复数据
 */
import fs from 'fs'
import path from 'path'
import Database from 'libsql'

const LIBSQL_URL = process.env.LIBSQL_URL
const LIBSQL_AUTH_TOKEN = process.env.LIBSQL_AUTH_TOKEN

if (!LIBSQL_URL || !/^libsql:\/\//.test(LIBSQL_URL)) {
  console.error('❌ 请先设置 LIBSQL_URL 环境变量（libsql://... 格式，来自 Turso 控制台）')
  console.error('   例如: set LIBSQL_URL=libsql://asi-workbench-yourname.turso.io')
  process.exit(1)
}
if (!LIBSQL_AUTH_TOKEN) {
  console.error('❌ 请先设置 LIBSQL_AUTH_TOKEN 环境变量（Turso 数据库的 Token）')
  process.exit(1)
}

const localFile = process.argv[2] || path.resolve(process.cwd(), '../data/asi-workbench.db')
if (!fs.existsSync(localFile)) {
  console.error(`❌ 本地数据库文件不存在: ${localFile}`)
  console.error('   可传入路径参数: node scripts/migrate-to-turso.mjs C:\\path\\to\\asi-workbench.db')
  process.exit(1)
}

console.log(`本地库: ${localFile}`)
console.log(`远程库: ${LIBSQL_URL}\n`)

const local = new Database(localFile, { readonly: true })
const remote = new Database(LIBSQL_URL, { authToken: LIBSQL_AUTH_TOKEN })

// 1. 在远程建表（与 db.ts 保持一致）
remote.exec(`
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  source_title TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_keywords TEXT NOT NULL DEFAULT '[]',
  amazon_title TEXT NOT NULL DEFAULT '',
  price_cny REAL,
  price_max_cny REAL,
  moq INTEGER,
  supplier TEXT NOT NULL DEFAULT '',
  material_cn TEXT NOT NULL DEFAULT '',
  colors_cn TEXT NOT NULL DEFAULT '',
  size_cn TEXT NOT NULL DEFAULT '',
  weight_g REAL,
  carton_l_cm REAL,
  carton_w_cm REAL,
  carton_h_cm REAL,
  pcs_per_carton INTEGER,
  carton_gw_kg REAL,
  images TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  score INTEGER,
  verdict TEXT,
  evaluation TEXT,
  listing TEXT,
  status TEXT NOT NULL DEFAULT 'sourced',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
`)

// 2. 读取本地表结构，确定 products 实际存在的列（老库可能缺列）
const localCols = local.prepare('PRAGMA table_info(products)').all().map((c) => c.name)
const allCols = [
  'id', 'source_title', 'source_url', 'description', 'source_keywords', 'amazon_title',
  'price_cny', 'price_max_cny', 'moq', 'supplier', 'material_cn', 'colors_cn', 'size_cn',
  'weight_g', 'carton_l_cm', 'carton_w_cm', 'carton_h_cm', 'pcs_per_carton', 'carton_gw_kg',
  'images', 'category', 'notes', 'score', 'verdict', 'evaluation', 'listing',
  'status', 'created_at', 'updated_at', 'similar', 'trashed_at',
]
const useCols = allCols.filter((c) => localCols.includes(c))
console.log(`products 本地列（${useCols.length}）: ${useCols.join(', ')}\n`)

function stripMeta(row) {
  if (row && typeof row === 'object' && '_metadata' in row) {
    const { _metadata, ...rest } = row
    return rest
  }
  return row
}

function migrateTable(tableName, cols) {
  const rows = local.prepare(`SELECT ${cols.join(', ')} FROM ${tableName}`).all().map(stripMeta)
  if (rows.length === 0) {
    console.log(`⏭  ${tableName}: 0 行，跳过`)
    return 0
  }
  const placeholders = cols.map(() => '?').join(', ')
  const sql = `INSERT OR REPLACE INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`
  const stmt = remote.prepare(sql)
  let n = 0
  for (const row of rows) {
    stmt.run(...cols.map((c) => row[c]))
    n++
  }
  console.log(`✅ ${tableName}: 迁移 ${n} 行`)
  return n
}

let total = 0
total += migrateTable('products', useCols)
total += migrateTable('settings', ['key', 'value'])
total += migrateTable('drafts', ['id', 'title', 'content', 'created_at', 'updated_at'])

// 3. 校验
const counts = {
  products: remote.prepare('SELECT COUNT(*) AS c FROM products').get().c,
  settings: remote.prepare('SELECT COUNT(*) AS c FROM settings').get().c,
  drafts: remote.prepare('SELECT COUNT(*) AS c FROM drafts').get().c,
}
console.log('\n远程库行数校验:', JSON.stringify(counts))
console.log(total > 0 ? '\n🎉 迁移完成！' : '\n（本地无数据需要迁移）')

local.close()
remote.close()
