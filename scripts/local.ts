// Runs the full mirror (realtime + reconcile) in Bun against a local SQLite file.
// Read-only toward Slack: mark-read is disabled here.
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { Effect, Layer, Logger, LogLevel } from "effect"
import { runMirror } from "../src/ingest/mirror.ts"
import { SlackApiLive } from "../src/slack/api.ts"
import { GlobalSockets } from "../src/slack/rtm.ts"
import { SqlDb } from "../src/store/sql.ts"
import { StoreLive } from "../src/store/store.ts"
import { bunSql } from "./bun-sql.ts"
import { loadSession } from "./session.ts"

const { creds, domain } = loadSession()
const db = new Database(process.argv[2] ?? `${homedir()}/.slack-mirror/local.db`)
db.exec("PRAGMA journal_mode = WAL")
const layer = Layer.mergeAll(
  StoreLive.pipe(Layer.provide(Layer.succeed(SqlDb, bunSql(db)))),
  SlackApiLive(creds, { apiBase: `https://${domain}.slack.com/api/`, allowMarkRead: false }),
  GlobalSockets,
)
await Effect.runPromise(runMirror().pipe(Effect.provide(layer), Logger.withMinimumLogLevel(LogLevel.Info)))
