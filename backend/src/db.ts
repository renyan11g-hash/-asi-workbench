import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

/**
 * 使用 Node 内置 node:sqlite（实验特性）。
 * 运行需带 --experimental-sqlite，已在 package.json 的 dev/start 脚本中注入 NODE_OPTIONS。
 */
const require_ = createRequire(`${process.cwd()}/`)

interface StatementSync {
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...args: unknown[]): unknown
  all(...args: unknown[]): unknown[]
}

interface DatabaseSyncType {
  exec(sql: string): void
  prepare(sql: string): StatementSync
  close(): void
}

const { DatabaseSync } = require_('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSyncType
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const dbPath = path.join(DATA_DIR, 'asi-workbench.db')
export const db = new DatabaseSync(dbPath)

// 启用 WAL 并发模式（线上发布实例与本地 dev 实例共用同一个 DB）
db.exec('PRAGMA journal_mode = WAL;')
db.exec('PRAGMA synchronous = NORMAL;')

db.exec(`
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

CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
`)

// 老表结构兼容：缺列则补齐
function ensureColumn(name: string, ddl: string) {
  const cols = (db.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>).map(
    (c) => c.name
  )
  if (!cols.includes(name)) {
    db.exec(`ALTER TABLE products ADD COLUMN ${ddl}`)
  }
}

ensureColumn('description', "description TEXT NOT NULL DEFAULT ''")
ensureColumn('source_keywords', "source_keywords TEXT NOT NULL DEFAULT '[]'")
ensureColumn('amazon_title', "amazon_title TEXT NOT NULL DEFAULT ''")
ensureColumn('carton_l_cm', 'carton_l_cm REAL')
ensureColumn('carton_w_cm', 'carton_w_cm REAL')
ensureColumn('carton_h_cm', 'carton_h_cm REAL')
ensureColumn('pcs_per_carton', 'pcs_per_carton INTEGER')
ensureColumn('carton_gw_kg', 'carton_gw_kg REAL')
ensureColumn('similar', "similar TEXT NOT NULL DEFAULT '{}'")
ensureColumn('trashed_at', 'trashed_at TEXT')

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as unknown as {
    key: string
    value: string
  }[]
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}