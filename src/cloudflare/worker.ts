import { DurableObject } from "cloudflare:workers"
import { Effect, Exit, Fiber, Layer, Logger, LogLevel } from "effect"
import { handleApi, type ApiActions } from "../api/http.ts"
import { handleMcp } from "../api/mcp.ts"
import { defaultMirrorConfig, runMirror } from "../ingest/mirror.ts"
import { authTest, makeSlackApi, markConversation, markThread, SlackApi, type SlackCredentials } from "../slack/api.ts"
import { WorkersSockets } from "../slack/rtm.ts"
import { migrate } from "../store/migrations.ts"
import { makeRepo, Store, type Repo } from "../store/store.ts"
import { decryptJson, encryptJson } from "./crypto.ts"
import { doSql } from "./do-sql.ts"

export { default } from "./oauth.ts"

export interface Env {
  MIRROR: DurableObjectNamespace<MirrorDO>
  OAUTH_KV: KVNamespace
  /** Canonical public origin serving /mcp, /v1 and the OAuth endpoints. */
  PUBLIC_URL: string
  /** Hostname behind an access gateway (e.g. Cloudflare Access) that serves the /authorize consent page. */
  AUTH_HOST: string
  /** The only gateway identity allowed to approve OAuth clients. */
  OWNER_EMAIL: string
  /** Header the gateway sets to the signed-in email (default: Cloudflare Access's). */
  IDENTITY_EMAIL_HEADER?: string
  /** Optional JSON object of extra gateway headers that must match exactly, e.g. {"x-org-id":"…"}. */
  IDENTITY_REQUIRE?: string
  /** Slack web session as secrets (xoxc token + d cookie), or an xoxp token alone. */
  SLACK_TOKEN?: string
  SLACK_COOKIE?: string
  /** AES key (any string) for a session pushed via POST /v1/auth/session. */
  SESSION_KEY?: string
  SLACK_API_BASE?: string
  CHANNEL_HISTORY_HOURS?: string
  DM_HISTORY_HOURS?: string
  THREAD_HISTORY_HOURS?: string
}

const WATCHDOG_MS = 30_000

export class MirrorDO extends DurableObject<Env> {
  private readonly repo: Repo
  private engine: Fiber.RuntimeFiber<unknown, unknown> | undefined
  private creds: SlackCredentials | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = doSql(ctx.storage)
    migrate(sql)
    this.repo = makeRepo(sql)
    ctx.blockConcurrencyWhile(async () => {
      await this.ensureRunning()
    })
  }

  private get apiBase() {
    return this.env.SLACK_API_BASE ?? "https://slack.com/api/"
  }

  private get sessionKey() {
    if (!this.env.SESSION_KEY) throw new Error("SESSION_KEY secret not configured")
    return this.env.SESSION_KEY
  }

  private async loadCreds(): Promise<SlackCredentials | undefined> {
    if (this.env.SLACK_TOKEN && this.env.SLACK_COOKIE) return { kind: "session", token: this.env.SLACK_TOKEN, cookie: this.env.SLACK_COOKIE }
    if (this.env.SLACK_TOKEN?.startsWith("xoxp-")) return { kind: "oauth", token: this.env.SLACK_TOKEN }
    const stored = await this.ctx.storage.get<string>("session")
    if (!stored) return undefined
    return decryptJson<SlackCredentials>(stored, this.sessionKey)
  }

  private layer(creds: SlackCredentials) {
    return Layer.mergeAll(
      Layer.succeed(Store, this.repo),
      Layer.succeed(SlackApi, makeSlackApi(creds, { apiBase: this.apiBase, allowMarkRead: false })),
      WorkersSockets,
    )
  }

  private get windows() {
    const num = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d)
    return {
      channelHours: num(this.env.CHANNEL_HISTORY_HOURS, 48),
      dmHours: num(this.env.DM_HISTORY_HOURS, 48),
      threadHours: num(this.env.THREAD_HISTORY_HOURS, 48),
    }
  }

  private config() {
    const w = this.windows
    return {
      ...defaultMirrorConfig,
      sync: { ...defaultMirrorConfig.sync, channelWindowMs: w.channelHours * 3600_000, dmWindowMs: w.dmHours * 3600_000, threadWindowMs: w.threadHours * 3600_000 },
    }
  }

  /** Starts the mirror if it isn't running; called on construction, alarms and requests. */
  private async ensureRunning(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS)
    if (this.engine) {
      const done = this.engine.unsafePoll()
      if (!done) return
      this.engine = undefined
      if (Exit.isFailure(done)) this.repo.setMeta("engine_error", `${new Date().toISOString()} ${String(done.cause).slice(0, 500)}`)
    }
    this.creds ??= await this.loadCreds()
    if (!this.creds) {
      this.repo.setMeta("rtm_state", "signed_out")
      return
    }
    const authErr = this.repo.getMeta("auth_error")
    const lastTry = Number(this.repo.getMeta("engine_started_at") ?? 0)
    if (authErr && Date.now() - lastTry < 5 * 60_000) return // don't hammer Slack with a dead session
    this.repo.setMeta("engine_started_at", String(Date.now()))
    this.engine = Effect.runFork(
      runMirror(this.config()).pipe(
        Effect.tapErrorTag("SlackAuthError", (e) => Effect.sync(() => this.repo.setMeta("auth_error", `${e.method}: ${e.error}`))),
        Effect.provide(this.layer(this.creds)),
        Logger.withMinimumLogLevel(LogLevel.Info),
      ),
    )
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS)
    await this.ensureRunning()
  }

  private actions(): ApiActions {
    return {
      windows: this.windows,
      reconcileNow: () => Effect.promise(() => this.restart()),
      setSession: ({ token, cookie }) =>
        Effect.gen(this, function* () {
          const creds: SlackCredentials = { kind: "session", token, cookie }
          const api = makeSlackApi(creds, { apiBase: this.apiBase, allowMarkRead: false })
          const who = yield* authTest.pipe(Effect.provideService(SlackApi, api))
          const prev = this.repo.identity()
          if (prev && prev.selfUserId !== who.user_id) {
            return yield* Effect.fail({ _tag: "WrongUser", message: `mirror belongs to ${prev.selfUserId}, session is ${who.user_id}` })
          }
          yield* Effect.promise(() => encryptJson(creds, this.sessionKey).then((v) => this.ctx.storage.put("session", v)))
          this.repo.setMeta("auth_error", null)
          this.creds = creds
          yield* Effect.promise(() => this.restart())
          return { user: who.user, user_id: who.user_id, team: who.team }
        }),
      markRead: ({ channel, ts, threadTs }) =>
        Effect.gen(this, function* () {
          if (!this.creds) return yield* Effect.fail({ _tag: "NotSignedIn" })
          const api = makeSlackApi(this.creds, { apiBase: this.apiBase, allowMarkRead: true })
          yield* (threadTs ? markThread(channel, threadTs, ts) : markConversation(channel, ts)).pipe(Effect.provideService(SlackApi, api))
          // Slack echoes *_marked / thread_marked over RTM; apply locally right away too.
          if (threadTs) this.repo.patchThreadRead(channel, threadTs, { last_read: ts }, "mark-read")
          else this.repo.patchChannelRead(channel, { last_read: ts }, "mark-read")
          this.repo.logEvent("api", { type: "mark_read", channel, ts }, { channel, ts, thread_ts: threadTs })
        }),
    }
  }

  private async restart() {
    if (this.engine) await Effect.runPromise(Fiber.interrupt(this.engine))
    this.engine = undefined
    this.repo.setMeta("engine_started_at", "0")
    await this.ensureRunning()
  }

  override async fetch(req: Request): Promise<Response> {
    await this.ensureRunning()
    const path = new URL(req.url).pathname
    if (path === "/mcp") return Effect.runPromise(handleMcp(this.repo, req, this.actions()))
    return Effect.runPromise(handleApi(this.repo, req, this.actions()))
  }
}

