// Ad-hoc read-only query against a local mirror DB: bun scripts/q.ts "SELECT ..." [db]
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
const db = new Database(process.argv[3] ?? `${homedir()}/.slack-mirror/local.db`, { readonly: true })
console.table(db.query(process.argv[2] ?? "SELECT 1").all())
