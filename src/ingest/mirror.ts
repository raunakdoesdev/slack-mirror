import { Duration, Effect, Fiber, Queue, Ref, Stream } from "effect"
import { SlackApi } from "../slack/api.ts"
import { defaultRtmOptions, rtmStream, SocketFactory, type RtmOptions } from "../slack/rtm.ts"
import { Store } from "../store/store.ts"
import { reduceEvent } from "./reduce.ts"
import * as Sync from "./sync.ts"

export interface MirrorConfig {
  readonly sync: Sync.SyncConfig
  readonly rtm: RtmOptions
  /** Full reconcile (counts + threads view + gap fill) at least this often. */
  readonly reconcileEveryMs: number
  readonly housekeepingEveryMs: number
  readonly eventRetentionMs: number
}
export const defaultMirrorConfig: MirrorConfig = {
  sync: Sync.defaultSyncConfig,
  rtm: defaultRtmOptions,
  reconcileEveryMs: 5 * 60_000,
  housekeepingEveryMs: 10_000,
  eventRetentionMs: 72 * 3600_000,
}

/**
 * The whole mirror as one long-running Effect:
 *  - realtime: RTM websocket stream -> reducer, reconnecting forever with backoff
 *  - reconcile: client.counts + thread view + 48h gap fill on (re)connect and every few minutes
 *  - housekeeping: fetch metadata for unknown users/conversations, prune the event log
 */
export const runMirror = (cfg: MirrorConfig = defaultMirrorConfig) =>
  Effect.gen(function* () {
    const repo = yield* Store
    const wake = yield* Queue.sliding<"reconnected" | "more">(1)
    const unknownConvs = new Set<string>()
    const unknownUsers = new Set<string>()
    const setMeta = (k: string, v: string | null) => Effect.sync(() => repo.setMeta(k, v))

    yield* Sync.bootstrap
    yield* setMeta("auth_error", null)
    const userCount = repo.sql.all<{ n: number }>("SELECT count(*) AS n FROM users WHERE name IS NOT NULL")[0]?.n ?? 0
    if (userCount < 10) yield* Effect.forkScoped(Sync.syncUsers.pipe(Effect.catchAll((e) => Effect.logWarning(`users.list: ${e._tag}`))))

    const handle = (raw: Record<string, unknown>) =>
      Effect.sync(() => {
        const r = reduceEvent(repo, raw)
        r.unknownConversations.forEach((c) => unknownConvs.add(c))
        r.unknownUsers.forEach((u) => unknownUsers.add(u))
        return r
      }).pipe(
        Effect.tap((r) =>
          r.control?.type === "hello"
            ? Effect.all([setMeta("rtm_state", "connected"), setMeta("rtm_connected_at", String(Date.now())), wake.offer("reconnected")])
            : r.prefChanged === "all_notifications_prefs" || r.prefChanged === "muted_channels"
              ? Sync.bootstrap.pipe(Effect.ignore)
              : Effect.void,
        ),
      )

    // Realtime: each session runs until the socket fails; reconnect with capped backoff that
    // resets after a healthy session. Every reconnect triggers a gap-filling reconcile.
    const backoff = yield* Ref.make(1_000)
    const session = Effect.gen(function* () {
      yield* setMeta("rtm_state", "connecting")
      const started = Date.now()
      const exit = yield* rtmStream(cfg.rtm).pipe(Stream.runForEach(handle), Effect.either)
      const err = exit._tag === "Left" ? exit.left.message : "ended"
      yield* setMeta("rtm_state", "disconnected")
      yield* setMeta("rtm_last_error", `${new Date().toISOString()} ${err}`)
      if (Date.now() - started > 60_000) yield* Ref.set(backoff, 1_000)
      const delay = yield* Ref.getAndUpdate(backoff, (d) => Math.min(d * 2, 60_000))
      yield* Effect.logWarning(`rtm disconnected (${err}); reconnecting in ${delay}ms`)
      yield* Effect.sleep(Duration.millis(delay))
    })
    const realtime = Effect.forever(session)

    const reconcileOnce = Sync.reconcile(cfg.sync).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          repo.setMeta("last_reconcile_at", String(Date.now()))
          repo.setMeta("last_reconcile", JSON.stringify({ new: r.newMessages.length, filled: r.filled, staleRemaining: r.staleRemaining, threadsFilled: r.threadsFilled, unreadThreads: r.unreadThreads }))
        }),
      ),
      Effect.tap((r) => (r.staleRemaining > 0 ? wake.offer("more") : Effect.void)),
      Effect.catchTag("SlackRateLimited", (e) => Effect.logWarning(`rate limited ${e.method}`).pipe(Effect.zipRight(Effect.sleep(Duration.millis(e.retryAfterMs))))),
      Effect.catchTag("SlackAuthError", (e) => setMeta("auth_error", `${e.method}: ${e.error}`)),
      Effect.catchAll((e) => Effect.logError(`reconcile failed: ${e._tag}`)),
    )
    const reconciler = Effect.forever(
      Queue.take(wake).pipe(
        Effect.timeout(Duration.millis(cfg.reconcileEveryMs)),
        Effect.ignore,
        Effect.zipRight(reconcileOnce),
        Effect.zipRight(Effect.sleep("2 seconds")),
      ),
    )

    const housekeeping = Effect.forever(
      Effect.gen(function* () {
        if (unknownConvs.size || unknownUsers.size) {
          const cs = [...unknownConvs].slice(0, 20)
          const us = [...unknownUsers].slice(0, 50)
          cs.forEach((c) => unknownConvs.delete(c))
          us.forEach((u) => unknownUsers.delete(u))
          yield* Sync.fillUnknown(cs, us)
        }
        yield* Effect.sync(() => repo.pruneEvents(cfg.eventRetentionMs))
      }).pipe(Effect.catchAllCause((c) => Effect.logError("housekeeping loop", c)), Effect.zipRight(Effect.sleep(Duration.millis(cfg.housekeepingEveryMs)))),
    )

    const fibers = [yield* Effect.forkScoped(realtime), yield* Effect.forkScoped(reconciler), yield* Effect.forkScoped(housekeeping)]
    yield* wake.offer("reconnected")
    yield* Fiber.joinAll(fibers)
  }).pipe(Effect.scoped)

export type MirrorRequirements = Store | SlackApi | SocketFactory
