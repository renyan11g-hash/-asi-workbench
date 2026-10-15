// 验证 libsql 包（better-sqlite3 兼容同步 API）能否直连 Turso
import Database from 'libsql'

// 1. 本地文件模式（与 node:sqlite 用法对比）
const db = new Database('./data/test-libsql.db')
db.exec('CREATE TABLE IF NOT EXISTS t (id TEXT, v TEXT)')
const stmt = db.prepare('INSERT INTO t (id, v) VALUES (?, ?)')
const r = stmt.run('a', '1')
console.log('run changes:', r.changes, 'lastInsertRowid:', r.lastInsertRowid)

const row = db.prepare('SELECT * FROM t WHERE id = ?').get('a')
console.log('get row:', JSON.stringify(row), 'id access:', row.id)

const rows = db.prepare('SELECT * FROM t').all()
console.log('all rows:', JSON.stringify(rows), 'is array:', Array.isArray(rows))

// 2. PRAGMA
db.exec('PRAGMA journal_mode = WAL;')
console.log('PRAGMA ok')

// 3. 远程模式（若配置了 Turso 环境变量则测试）
if (process.env.LIBSQL_URL && process.env.LIBSQL_AUTH_TOKEN) {
  const remote = new Database(process.env.LIBSQL_URL, { authToken: process.env.LIBSQL_AUTH_TOKEN })
  remote.exec('CREATE TABLE IF NOT EXISTS ping (k TEXT)')
  remote.prepare('INSERT INTO ping (k) VALUES (?)').run('hello-' + Date.now())
  const rr = remote.prepare('SELECT COUNT(*) AS c FROM ping').get()
  console.log('REMOTE OK, ping count:', rr.c)
  remote.close()
} else {
  console.log('LIBSQL_URL not set, skip remote test')
}

db.close()
console.log('ALL OK')
