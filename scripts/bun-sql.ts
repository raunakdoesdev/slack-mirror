import { Database } from "bun:sqlite"
import { bind, type Sql } from "../src/store/sql.ts"

export const bunSql = (db = new Database(":memory:")): Sql => ({
  all: <T>(q: string, ...p: ReadonlyArray<unknown>) => db.query(q).all(...(bind(p) as never[])) as T[],
  run: (q, ...p) => db.query(q).run(...(bind(p) as never[])).changes,
  script: (q) => db.exec(q),
  transaction: (f) => db.transaction(f)(),
})
