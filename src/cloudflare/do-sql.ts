import type { Sql } from "../store/sql.ts"
import { bind } from "../store/sql.ts"

/** Durable Object SQLite (ctx.storage.sql) behind the shared Sql interface. */
export const doSql = (storage: DurableObjectStorage): Sql => {
  let depth = 0
  return {
    all: <T>(q: string, ...p: ReadonlyArray<unknown>) => storage.sql.exec(q, ...bind(p)).toArray() as T[],
    run: (q, ...p) => storage.sql.exec(q, ...bind(p)).rowsWritten,
    script: (q) => void storage.sql.exec(q),
    transaction: <A>(f: () => A): A => {
      if (depth > 0) return f()
      depth++
      try {
        return storage.transactionSync(f)
      } finally {
        depth--
      }
    },
  }
}
