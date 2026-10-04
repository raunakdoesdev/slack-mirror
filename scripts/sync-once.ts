// Runs bootstrap + one reconcile pass against real Slack into a local SQLite file (read-only toward Slack).
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { Effect, Layer } from "effect"
import * as Sync from "../src/ingest/sync.ts"
import { SlackApiLive } from "../src/slack/api.ts"
import { StoreLive } from "../src/store/store.ts"
import { SqlDb } from "../src/store/sql.ts"
import { bunSql } from "./bun-sql.ts"
import { loadSession } from "./session.ts"

const { creds, domain } = loadSession()
const db = new Database(process.argv[2] ?? `${homedir()}/.slack-mirror/local.db`)
const layer = StoreLive.pipe(
  Layer.provideMerge(Layer.succeed(SqlDb, bunSql(db))),
  Layer.merge(SlackApiLive(creds, { apiBase: `https://${domain}.slack.com/api/`, allowMarkRead: false })),
)
const program = Effect.gen(function* () {
  const t0 = Date.now()
  console.log("bootstrap", yield* Sync.bootstrap, Date.now() - t0, "ms")
  const r = yield* Sync.reconcile({ ...Sync.defaultSyncConfig, maxConversationsPerPass: Number(process.env.MAX_CONV ?? 15) })
  console.log("reconcile", { new: r.newMessages.length, read: r.readMoved.length, filled: r.filled, staleRemaining: r.staleRemaining, threads: r.threadsFilled, unreadThreads: r.unreadThreads }, Date.now() - t0, "ms")
})
await Effect.runPromise(program.pipe(Effect.provide(layer)))
console.log(db.query("SELECT (SELECT count(*) FROM messages) m, (SELECT count(*) FROM conversations) c, (SELECT count(*) FROM channel_reads) cr, (SELECT count(*) FROM thread_reads) tr, (SELECT count(*) FROM thread_reads WHERE unread_count > 0) tru").get())
