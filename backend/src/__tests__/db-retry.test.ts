import { withTransientRetry, isTransientDbError } from '../db'

/**
 * 2026-11-09 事故回归：Turso 偶发 `Hrana(Http("connection closed before message completed"))`
 * 打在前端首屏的读接口上，一次断连就让整页打不开。读语句必须自动重试，写语句不能重试。
 */

type AnyStmt = {
  run: (...a: unknown[]) => { changes: number; lastInsertRowid: number | bigint }
  get: (...a: unknown[]) => unknown
  all: (...a: unknown[]) => unknown[]
}

/** 造一个「前 n 次 prepare 抛断连错误」的假库 */
function flakyDb(failures: number, rows: Array<Record<string, unknown>> = [{ ok: 1 }]) {
  let calls = 0
  const make = (): AnyStmt => ({
    run: () => ({ changes: 1, lastInsertRowid: 1 }),
    get: () => rows[0],
    all: () => rows,
  })
  return {
    prepareCalls: () => calls,
    db: {
      exec: () => undefined,
      close: () => undefined,
      prepare(sql: string) {
        calls += 1
        if (calls <= failures) {
          throw new Error('Hrana(Http("connection closed before message completed"))')
        }
        void sql
        return make()
      },
    },
  }
}

describe('isTransientDbError', () => {
  it('识别 Turso 断连', () => {
    expect(
      isTransientDbError(new Error('Hrana(Http("connection closed before message completed"))'))
    ).toBe(true)
    expect(isTransientDbError(new Error('ECONNRESET'))).toBe(true)
    expect(isTransientDbError(new Error('socket hang up'))).toBe(true)
  })

  it('不把业务/SQL 错误当断连（不能重试）', () => {
    expect(isTransientDbError(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'))).toBe(false)
    expect(isTransientDbError(new Error('no such column: foo'))).toBe(false)
    expect(isTransientDbError(new Error('invalid token'))).toBe(false)
  })
})

describe('withTransientRetry', () => {
  it('读语句遇到断连会自动重试并成功', () => {
    const { db, prepareCalls } = flakyDb(1)
    const wrapped = withTransientRetry(db)
    expect(wrapped.prepare('SELECT * FROM products').all()).toEqual([{ ok: 1 }])
    expect(prepareCalls()).toBe(2)
  })

  it('连续断连超过上限才把错误抛出来', () => {
    const { db } = flakyDb(99)
    const wrapped = withTransientRetry(db)
    expect(() => wrapped.prepare('SELECT 1').get()).toThrow(/Hrana/)
  })

  it('写语句不重试，避免重复插入', () => {
    const { db, prepareCalls } = flakyDb(1)
    const wrapped = withTransientRetry(db)
    expect(() => wrapped.prepare('INSERT INTO products (id) VALUES (?)')).toThrow(/Hrana/)
    expect(prepareCalls()).toBe(1)
  })

  it('非断连错误立即抛出，不做无意义重试', () => {
    let calls = 0
    const wrapped = withTransientRetry({
      exec: () => undefined,
      close: () => undefined,
      prepare: () => {
        calls += 1
        throw new Error('no such column: foo')
      },
    })
    expect(() => wrapped.prepare('SELECT * FROM products').all()).toThrow(/no such column/)
    expect(calls).toBe(1)
  })
})
