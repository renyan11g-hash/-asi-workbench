import fs from 'fs'
import path from 'path'
import Database from 'libsql'

/**
 * 数据库层：libsql（better-sqlite3 兼容同步 API）
 * - 默认本地文件模式（与原 node:sqlite 行为一致）
 * - 设置 LIBSQL_URL（libsql://...，可选 LIBSQL_AUTH_TOKEN）后直连 Turso 云数据库，
 *   线上 Render 容器文件系统是临时的，用 Turso 可让数据永久保存
 */

interface StatementLike {
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...args: unknown[]): unknown
  all(...args: unknown[]): unknown[]
}

interface DatabaseLike {
  exec(sql: string): void
  prepare(sql: string): StatementLike
  close(): void
}

function openDatabase(): DatabaseLike {
  const url = process.env.LIBSQL_URL
  const authToken = process.env.LIBSQL_AUTH_TOKEN

  if (url && /^libsql:\/\//.test(url)) {
    // 远程 Turso 模式（authToken 运行时支持，类型声明未包含，故断言）
    const opts = (authToken ? { authToken } : {}) as ConstructorParameters<typeof Database>[1]
    return new Database(url, opts) as unknown as DatabaseLike
  }

  // 本地文件模式
  const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const dbPath = path.join(DATA_DIR, 'asi-workbench.db')
  return new Database(dbPath) as unknown as DatabaseLike
}

export const db = openDatabase()

// 本地模式启用 WAL 并发；远程模式由 Turso 自行管理，PRAGMA 会报错则跳过
if (!process.env.LIBSQL_URL || !/^libsql:\/\//.test(process.env.LIBSQL_URL)) {
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
}

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

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

-- 订单运营中心表结构
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  country TEXT,
  type TEXT NOT NULL DEFAULT 'individual',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'price_inquiry',
  status TEXT NOT NULL DEFAULT 'new',
  product_id TEXT,
  ai_category TEXT,
  ai_draft TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  order_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  total_amount REAL NOT NULL,
  deposit_amount REAL,
  balance_amount REAL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  total_price REAL NOT NULL,
  imprint_spec TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS supplier_communications (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  contact_method TEXT NOT NULL DEFAULT 'email',
  content TEXT NOT NULL,
  response TEXT,
  price_cny REAL,
  moq INTEGER,
  lead_time TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS email_drafts (
  id TEXT PRIMARY KEY,
  inquiry_id TEXT,
  customer_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  is_ai_generated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (inquiry_id) REFERENCES inquiries(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  tracking_number TEXT,
  carrier TEXT,
  shipping_method TEXT NOT NULL DEFAULT 'air',
  status TEXT NOT NULL DEFAULT 'pending',
  estimated_delivery TEXT,
  actual_delivery TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  amount REAL NOT NULL,
  payment_method TEXT NOT NULL,
  payment_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS after_sales (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'quality_issue',
  status TEXT NOT NULL DEFAULT 'open',
  description TEXT NOT NULL,
  resolution TEXT,
  refund_amount REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- 订单运营中心索引
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_inquiries_customer ON inquiries(customer_id);
CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_supplier_comm_product ON supplier_communications(product_id);
CREATE INDEX IF NOT EXISTS idx_email_drafts_customer ON email_drafts(customer_id);
CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_after_sales_order ON after_sales(order_id);
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
ensureColumn('draft_id', 'draft_id TEXT')

/**
 * libsql 的 get() 结果可能带 _metadata 字段（查询耗时元数据），剥离后返回纯数据行
 */
function cleanRow<T>(row: unknown): T | undefined {
  if (row === undefined || row === null) return undefined
  if (typeof row === 'object' && row !== null && '_metadata' in row) {
    const { _metadata, ...rest } = row as Record<string, unknown>
    return rest as T
  }
  return row as T
}

export function getSetting(key: string): string | null {
  const row = cleanRow<{ value: string }>(
    db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  )
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
