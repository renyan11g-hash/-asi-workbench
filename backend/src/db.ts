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

/** 同步等待（初始化重试用；libsql 是同步 API，不能用 await） */
const sleepSync = (ms: number) => {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

/**
 * 启动期建表/补列的容错包装。
 *
 * 2026-11-02 线上事故：新实例启动时某一条 PRAGMA 返回 `invalid token`，
 * 整个进程直接退出 → Render 判定部署失败 → 线上一直停在旧版本，前端改动永远上不去。
 * 建表/补列失败不该等于服务不可用：重试几次，仍失败就记日志继续启动，
 * 让健康检查通过、让页面能打开（接口会各自报错），留出人工修复的空间。
 */
function tryExec(label: string, fn: () => void) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      fn()
      return
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      if (attempt === 3) {
        console.error(`[db] 初始化步骤「${label}」失败（已跳过，服务继续启动）: ${msg}`)
      } else {
        console.warn(`[db] 初始化步骤「${label}」第 ${attempt} 次失败，重试: ${msg}`)
        sleepSync(800)
      }
    }
  }
}

// 本地模式启用 WAL 并发；远程模式由 Turso 自行管理，PRAGMA 会报错则跳过
if (!process.env.LIBSQL_URL || !/^libsql:\/\//.test(process.env.LIBSQL_URL)) {
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
}

const SCHEMA_SQL = `
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

-- 产品图片（AI 生成：主图/尺寸图/介绍图，含对话修改历史）
CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL DEFAULT '',
  history TEXT NOT NULL DEFAULT '[]',
  file TEXT NOT NULL,
  dimension_spec TEXT,
  with_logo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);

-- 「参考图」：人工上传/粘贴的行业优秀产品图，只用来学构图/排版/光线/场景，
-- 绝不允许改变自己产品的结构/外形/颜色/材质/配件/比例/功能/纹理。
-- 和「产品图」（products.images，来自 1688 或人工上传的产品真身图）是两回事，必须分开存。
CREATE TABLE IF NOT EXISTS product_ref_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_ref_images_product ON product_ref_images(product_id);

-- 每种图（主图/尺寸图/细节图/场景图）各自的出图计划：
-- sources = 这张图要参考的产品图（从产品图里挑，保证图种之间参照不同图片，更准）
-- notes   = 生成前和 AI 对话确认的注意点
-- chat    = 对话记录（生成前先聊清楚，避免凭空发挥）
CREATE TABLE IF NOT EXISTS product_image_plan (
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  chat TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_id, kind)
);

-- 品牌 Logo（全局单条，key='brand-logo'，value=文件名）
CREATE TABLE IF NOT EXISTS brand_assets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 图片二进制持久化：Render 容器 /tmp 会被部署清空，文件系统仅作缓存，
-- 真身存 DB（key = 'productId/文件名' 或 '_brand/logo'），读取时缓存缺失自动恢复
CREATE TABLE IF NOT EXISTS image_blobs (
  key TEXT PRIMARY KEY,
  data BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

-- 批量处理任务：一次粘贴多个 1688 链接，后台跑「抓取 → 人工补全 → 评估 → 入库」。
-- 落库是为了刷新页面/服务重启后还能看到每条跑到哪一步，而不是任务凭空消失。
-- phase 记录数据走到哪一站（draft/fetched/evaluated/saved），status 记录当前有没有在跑。
CREATE TABLE IF NOT EXISTS batch_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'draft',
  phase TEXT NOT NULL DEFAULT 'draft',
  options TEXT NOT NULL DEFAULT '{}',
  items TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_created ON batch_jobs(created_at);

-- 产品资料库（自建主数据）：同一条 1688 链接只要录一次，之后抓取时直接命中这里，
-- 不用再重复补箱规/图片。images 存多张图（JSON 数组），出图时作为参考图。
CREATE TABLE IF NOT EXISTS master_products (
  id TEXT PRIMARY KEY,
  offer_id TEXT,
  source_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  price_cny REAL,
  size_cn TEXT NOT NULL DEFAULT '',
  weight_g REAL,
  carton_l_cm REAL,
  carton_w_cm REAL,
  carton_h_cm REAL,
  pcs_per_carton INTEGER,
  carton_gw_kg REAL,
  images TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  supplier TEXT NOT NULL DEFAULT '',
  material_cn TEXT NOT NULL DEFAULT '',
  colors_cn TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_master_offer ON master_products(offer_id);
CREATE INDEX IF NOT EXISTS idx_master_url ON master_products(source_url);

-- 每条产品的评估结果单独放：评估对象里带海外同款明细（约 6KB），
-- 塞进 items JSON 会让每次「进度更新」都重写几百 KB，单独存一张表就只写一次。
CREATE TABLE IF NOT EXISTS batch_item_evals (
  job_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  evaluation TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, idx)
);

-- 批量条目里的产品图单独存：资料库里的图是 data URL（一张 50–130KB），
-- 塞进 items JSON 会让每次「进度更新」都重写好几 MB，也会撑爆单行大小上限。
CREATE TABLE IF NOT EXISTS batch_item_images (
  job_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  images TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, idx)
);

-- 英文链接待审核库：批量生成的 listing 先放这里，人工审核通过后才写进 products。
-- 审核状态 pending / approved / rejected，approved 时 product_id 记录落到产品库的那一条。
CREATE TABLE IF NOT EXISTS listing_reviews (
  id TEXT PRIMARY KEY,
  batch_job_id TEXT,
  batch_idx INTEGER,
  title TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  image TEXT,
  score INTEGER,
  verdict TEXT,
  source TEXT NOT NULL DEFAULT '{}',
  evaluation TEXT,
  listing TEXT NOT NULL DEFAULT '{}',
  price_grid TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  product_id TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listing_reviews_status ON listing_reviews(status);
CREATE INDEX IF NOT EXISTS idx_listing_reviews_batch ON listing_reviews(batch_job_id);

-- 产品结构化资料（14 个标准字段）：单个录入和批量录入的产品都会有一条。
-- data 存字段 JSON；原始资料仍然留在 products 表里，这里只存「整理后的结果」，
-- 所以结构化失败/字段标 Unknown 都不会影响原始数据。
CREATE TABLE IF NOT EXISTS product_specs (
  product_id TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}',
  unknown_fields TEXT NOT NULL DEFAULT '[]',
  source_hash TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  extracted_at TEXT,
  edited_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 批量生产任务（Listing 批量生成 / 结构化资料批量提取）。
-- 与 batch_jobs（1688 链接批量抓取）是两回事：那个从链接起跑，这个从已有产品档案起跑。
-- items 只存「每条产品的进度与结果引用」，成品 listing 落在 listing_reviews 里，不塞进这一行。
CREATE TABLE IF NOT EXISTS production_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'listing',
  status TEXT NOT NULL DEFAULT 'queued',
  options TEXT NOT NULL DEFAULT '{}',
  items TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  client_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_production_jobs_created ON production_jobs(created_at);

-- 模型调用台账：哪个任务、哪个模型、多久、多少 token、成功还是失败。
-- 只追加不更新，用来回答「这次批量到底花了多少、哪一步慢、哪一步老失败」。
CREATE TABLE IF NOT EXISTS ai_call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL DEFAULT '',
  product_id TEXT,
  model TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_call_logs_created ON ai_call_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_call_logs_task ON ai_call_logs(task);

-- 服务器异常留档：这台跑在 Render 上，用户看不到日志、我也拿不到，
-- 所以 500 现场直接写库，用 GET /api/health/errors 就能查到真正原因。
CREATE TABLE IF NOT EXISTS server_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  stack TEXT,
  created_at TEXT NOT NULL
);

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

-- 索引
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
`
tryExec('建表 + 索引', () => db.exec(SCHEMA_SQL))

// 老表结构兼容：缺列则补齐
function ensureColumn(name: string, ddl: string) {
  tryExec(`products.${name}`, () => {
    const cols = (db.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE products ADD COLUMN ${ddl}`)
    }
  })
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

// 评分 v2（按市场 list 反算能不能赚钱）：只新增列，原 score/verdict/evaluation 一律不动
ensureColumn('score_v2', 'score_v2 INTEGER')
ensureColumn('verdict_v2', 'verdict_v2 TEXT')
ensureColumn('margin_v2', 'margin_v2 REAL')
ensureColumn('ceiling_cny', 'ceiling_cny REAL')
ensureColumn('scored_at', 'scored_at TEXT')

// 审核队列：null 一律视为待审（pending），老数据不用批量回填
ensureColumn('review_state', 'review_state TEXT')
ensureColumn('review_note', 'review_note TEXT')
ensureColumn('reject_reasons', 'reject_reasons TEXT')
ensureColumn('reviewed_at', 'reviewed_at TEXT')

// 选品来源：manual=自己粘链接/评估库；auto=每日自动选品
ensureColumn('origin', "origin TEXT NOT NULL DEFAULT 'manual'")
ensureColumn('selection_reason', 'selection_reason TEXT')

// 产品编号（RPA0001 这样的对外编号）：一个产品从录入到上架始终是同一个编号，
// 流水线上认编号比认 UUID 方便，也方便和 Excel / ASI ESP 里的记录对上。
ensureColumn('code', "code TEXT NOT NULL DEFAULT ''")

// 英文标题单独存一列：流水线列表要显示「英文文案写到哪了」，
// 但要显示英文标题就得把整条 listing JSON 都读出来（一条几 KB、几百条就是几 MB）。
ensureColumn('listing_title', "listing_title TEXT NOT NULL DEFAULT ''")

// 市场参考价（人工在 ESP / ASI 目录查到的同款 list 价）：优先级高于 AI 估价
ensureColumn('market_list_low', 'market_list_low REAL')
ensureColumn('market_list_high', 'market_list_high REAL')
ensureColumn('market_source', "market_source TEXT")
ensureColumn('market_checked_at', 'market_checked_at TEXT')

// ---- 编号体系（2026-11-07）：预产品库用 GLS0001…，RPA 档案库用手工新编号 ----
// gls_code 一旦发放不再变、也不再复用（即使产品被移进 RPA 档案库或删除）；
// prev_code 记录上一次的编号，方便追溯「GLS0031 → RPA670」这种改号。
ensureColumn('gls_code', 'gls_code TEXT')
ensureColumn('prev_code', 'prev_code TEXT')
// 产品现在在哪个库：pipeline=流水线/评估阶段，pre=预产品库，rpa=RPA 档案库
ensureColumn('library_state', "library_state TEXT NOT NULL DEFAULT 'pipeline'")
ensureColumn('rpa_archived_at', 'rpa_archived_at TEXT')
// 评估人工审核：null 未评估完 / pending 待审核 / approved 通过（自动去生成文案）/ rejected 不通过（待定）
ensureColumn('eval_review', 'eval_review TEXT')
ensureColumn('eval_reviewed_at', 'eval_reviewed_at TEXT')
// 产品资料库（master_products）导入后自动生成的产品档案，记下来源主数据 id，避免重复建档
ensureColumn('master_id', 'master_id TEXT')

// 批量任务：记住上一次跑的是哪个阶段，暂停/中断后能一键接着跑
ensureTableColumn('batch_jobs', 'last_stage', "last_stage TEXT NOT NULL DEFAULT ''")

// 订单运营中心表兼容性检查
function ensureTableColumn(tableName: string, name: string, ddl: string) {
  tryExec(`${tableName}.${name}`, () => {
    const cols = (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`)
    }
  })
}

// 确保订单表有所有必需的列
ensureTableColumn('orders', 'deposit_amount', 'deposit_amount REAL')
ensureTableColumn('orders', 'balance_amount', 'balance_amount REAL')

// 批量任务：老库补 phase 列（表是后建的，线上可能已存在旧结构）
ensureTableColumn('batch_jobs', 'phase', "phase TEXT NOT NULL DEFAULT 'draft'")

// 生成图的自检结果（产品/颜色/结构/配件/Logo 一致性、场景合理、白底、画质），JSON
ensureTableColumn('product_images', 'review', 'review TEXT')

// 产品图片表：老库补 with_logo 列（主图是否融合 Logo，0/1）
ensureTableColumn('product_images', 'with_logo', 'with_logo INTEGER NOT NULL DEFAULT 1')

// 待审核库：批量生产走「暂存草稿」模式后，需要知道这条审核记录
//   ① 是不是批量任务产出的（job_id）；
//   ② 通过时要不要把 listing 写回产品（mode='staged' 才写，'inline' 是旧的生成即写回）；
//   ③ 这条草稿的质量检查结果、人工编辑时间、被替换前的旧 listing（可回溯）。
ensureTableColumn('listing_reviews', 'job_id', 'job_id TEXT')
ensureTableColumn('listing_reviews', 'item_idx', 'item_idx INTEGER')
ensureTableColumn('listing_reviews', 'mode', "mode TEXT NOT NULL DEFAULT 'inline'")
ensureTableColumn('listing_reviews', 'qc', 'qc TEXT')
ensureTableColumn('listing_reviews', 'prev_listing', 'prev_listing TEXT')
ensureTableColumn('listing_reviews', 'edited_at', 'edited_at TEXT')

// 批量生产任务：client_key 用来挡住「手抖连点两次」造成的重复批次
ensureTableColumn('production_jobs', 'client_key', 'client_key TEXT')

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
