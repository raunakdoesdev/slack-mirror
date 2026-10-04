import { Effect } from "effect"
import * as Api from "../slack/api.ts"
import type * as S from "../slack/schema.ts"
import { millisToTs, tsGt } from "../slack/ts.ts"
import { Store, type Repo } from "../store/store.ts"
import type { Reduced } from "./reduce.ts"

export interface SyncConfig {
  /** History window for public/private channels (ms). Unread conversations always go back to last_read. */
  readonly channelWindowMs: number
  /** History window for DMs, group DMs and Slack Connect conversations (ms). */
  readonly dmWindowMs: number
  /** Reply backfill window for followed threads (ms). Unread threads are always fetched in full. */
  readonly threadWindowMs: number
  /** Max conversations to gap-fill per reconcile pass (keeps one pass bounded). */
  readonly maxConversationsPerPass: number
  readonly maxThreadsPerPass: number
  /** History/replies pages (200 messages each) per conversation or thread per pass; the rest resumes next pass. */
  readonly maxPagesPerFill: number
}
const HOUR = 3600_000
export const defaultSyncConfig: SyncConfig = {
  channelWindowMs: 48 * HOUR, dmWindowMs: 48 * HOUR, threadWindowMs: 48 * HOUR,
  maxConversationsPerPass: 40, maxThreadsPerPass: 60, maxPagesPerFill: 10,
}

/** Window start for one conversation: DMs, group DMs and Slack Connect use dmWindowMs. */
const windowStart = (cfg: SyncConfig, repo: Repo, conversationId: string) => {
  const c = repo.conversation(conversationId)
  const long = c ? c.kind === "im" || c.kind === "mpim" || c.is_ext_shared === 1 : conversationId.startsWith("D")
  return millisToTs(Date.now() - (long ? cfg.dmWindowMs : cfg.channelWindowMs))
}

/**
 * How far back history must reach for one conversation: its last_read when Slack says
 * it has unreads (no cap, so every unread message is stored), else the window start.
 */
export const historyTarget = (cfg: SyncConfig, repo: Repo, conversationId: string): string => {
  const w = windowStart(cfg, repo, conversationId)
  const r = repo.channelRead(conversationId)
  return r?.has_unreads && r.last_read != null && r.last_read < w ? r.last_read : w
}

const mutedFromPrefs = (prefs: S.UserBoot["prefs"]): Set<string> => {
  const muted = new Set<string>()
  try {
    const all = JSON.parse(prefs?.all_notifications_prefs ?? "{}") as { channels?: Record<string, { muted?: boolean }> }
    for (const [id, p] of Object.entries(all.channels ?? {})) if (p.muted) muted.add(id)
  } catch {
    /* ignore malformed prefs */
  }
  for (const id of (prefs?.muted_channels ?? "").split(",")) if (id) muted.add(id)
  return muted
}

/** client.userBoot: identity, every conversation the owner is in, mute prefs. */
export const bootstrap = Effect.gen(function* () {
  const repo = yield* Store
  const auth = yield* Api.authTest
  const boot = yield* Api.userBoot
  repo.sample("client.userBoot", { channels: boot.channels?.length, ims: boot.ims?.length })
  repo.sql.transaction(() => {
    repo.setIdentity(
      { selfUserId: auth.user_id, teamId: auth.team_id, groupIds: boot.subteams?.self ?? [] },
      { name: boot.team.name, domain: boot.team.domain, enterprise_id: boot.team.enterprise_id ?? auth.enterprise_id },
    )
    for (const c of boot.channels ?? []) repo.upsertConversation(c, { member: true })
    for (const c of boot.ims ?? []) repo.upsertConversation({ ...c, is_im: true }, { member: true })
    repo.setMuted(mutedFromPrefs(boot.prefs))
  })
  // userBoot caps its channel list (observed: 700), so page users.conversations for full membership.
  const member = new Set<string>([...(boot.channels ?? []), ...(boot.ims ?? [])].map((c) => c.id))
  let cursor: string | undefined
  let complete = false
  for (let page = 0; page < 50; page++) {
    const res = yield* usersConversations(cursor)
    repo.sql.transaction(() => res.channels.forEach((c) => {
      member.add(c.id)
      repo.upsertConversation(c, { member: true })
    }))
    cursor = res.response_metadata?.next_cursor ?? undefined
    if (!cursor) {
      complete = true
      break
    }
  }
  if (complete) {
    repo.sql.transaction(() => {
      for (const { id } of repo.sql.all<{ id: string }>("SELECT id FROM conversations WHERE is_member = 1")) {
        if (!member.has(id)) repo.setConversationField(id, "is_member", false)
      }
    })
  }
  return { channels: boot.channels?.length ?? 0, ims: boot.ims?.length ?? 0, member: member.size }
}).pipe(Effect.withSpan("sync.bootstrap"))

const usersConversations = (cursor?: string) =>
  Api.usersConversations(cursor).pipe(
    Effect.retry({ times: 3, while: (e) => e._tag === "SlackRateLimited" }),
  )

const applyCountsEntry = (repo: Repo, e: S.CountsEntry, kind: string) => {
  // client.counts also lists conversations the owner has left; membership comes from bootstrap.
  repo.ensureConversation(e.id, false)
  return repo.patchChannelRead(
    e.id,
    { last_read: e.last_read, latest: e.latest, has_unreads: e.has_unreads, mention_count: e.mention_count },
    `client.counts:${kind}`,
  )
}

/**
 * client.counts: authoritative per-channel last_read/latest/mentions for every
 * conversation in one call. Returns conversations whose `latest` is newer than
 * anything we've stored inside the window (=> we missed messages).
 */
export const reconcileCounts = (cfg: SyncConfig = defaultSyncConfig) =>
  Effect.gen(function* () {
    const repo = yield* Store
    const counts = yield* Api.clientCounts
    const stale: Array<{ id: string; unread: boolean; latest: string }> = []
    const connectedAt = Number(repo.getMeta("rtm_connected_at") ?? 0)
    const readMoved: Reduced["readMoved"] = []
    repo.sql.transaction(() => {
      for (const [kind, list] of [["channel", counts.channels], ["mpim", counts.mpims], ["im", counts.ims]] as const) {
        for (const e of list) {
          if (applyCountsEntry(repo, e, kind) && e.last_read) readMoved.push({ conversationId: e.id, threadTs: null, lastRead: e.last_read })
          if (e.latest && needsFill(repo, e.id, e.latest, historyTarget(cfg, repo, e.id), connectedAt))
            stale.push({ id: e.id, unread: !!e.has_unreads, latest: e.latest })
        }
      }
      const b = counts.channel_badges
      repo.sql.run(
        `INSERT INTO badges (id, thread_unreads, thread_mentions, channels, dms, raw, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET thread_unreads = excluded.thread_unreads, thread_mentions = excluded.thread_mentions,
           channels = excluded.channels, dms = excluded.dms, raw = excluded.raw, updated_at = excluded.updated_at`,
        b?.thread_unreads, b?.thread_mentions, b?.channels, b?.dms, JSON.stringify({ threads: counts.threads, channel_badges: b }), Date.now(),
      )
    })
    // Unread conversations first, then most recently active.
    stale.sort((a, b) => Number(b.unread) - Number(a.unread) || (a.latest < b.latest ? 1 : -1))
    return { stale: stale.map((x) => x.id), readMoved, conversations: counts.channels.length + counts.mpims.length + counts.ims.length }
  }).pipe(Effect.withSpan("sync.reconcileCounts"))

/**
 * Contiguous history range per conversation: every message in [oldest_ts, newest_ts] was
 * fetched via history. (max(ts) is not safe: thread-view roots or realtime messages can be
 * newer than a gap.) Rows from before oldest_ts was tracked count as covering newest_ts only.
 */
const watermark = (repo: Repo, conversationId: string) =>
  repo.sql.all<{ newest_ts: string | null; oldest_ts: string | null; updated_at: number; fill_error_at: number | null }>(
    "SELECT newest_ts, oldest_ts, updated_at, fill_error_at FROM sync_state WHERE conversation_id = ?", conversationId,
  )[0]

const setRange = (repo: Repo, conversationId: string, from: string, through: string) =>
  repo.sql.run(
    `INSERT INTO sync_state (conversation_id, oldest_ts, newest_ts, updated_at, fill_error, fill_error_at) VALUES (?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(conversation_id) DO UPDATE SET oldest_ts = excluded.oldest_ts, newest_ts = excluded.newest_ts,
       updated_at = excluded.updated_at, fill_error = NULL, fill_error_at = NULL`,
    conversationId, from, through, Date.now(),
  )

const setFillError = (repo: Repo, conversationId: string, error: string) =>
  repo.sql.run(
    `INSERT INTO sync_state (conversation_id, updated_at, fill_error, fill_error_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET fill_error = excluded.fill_error, fill_error_at = excluded.fill_error_at`,
    conversationId, Date.now(), error, Date.now(),
  )
const FILL_ERROR_RETRY_MS = 60 * 60_000

/**
 * A conversation needs a history fetch when it has messages after `target` and either the
 * stored range doesn't reach down to `target`, or Slack's `latest` is past its top (unless
 * realtime has been connected since the range was set and delivered that message: then
 * history is contiguous; just advance).
 */
const needsFill = (repo: Repo, conversationId: string, latest: string, target: string, connectedAt: number): boolean => {
  if (latest <= target) return false
  const w = watermark(repo, conversationId)
  if (w?.fill_error_at && Date.now() - w.fill_error_at < FILL_ERROR_RETRY_MS) return false
  if (!w?.newest_ts || w.newest_ts < target) return true
  const from = w.oldest_ts ?? w.newest_ts
  if (tsGt(from, target)) return true
  if (from === target && Number(target) > 0 && !storedAtOrBefore(repo, conversationId, target)) return true
  if (!tsGt(latest, w.newest_ts)) return false
  if (w && connectedAt > 0 && w.updated_at >= connectedAt && repo.message(conversationId, latest)) {
    repo.sql.run("UPDATE sync_state SET newest_ts = ?, updated_at = ? WHERE conversation_id = ?", latest, Date.now(), conversationId)
    return false
  }
  return true
}

/**
 * subscriptions.thread.getView: subscribed threads (newest activity first) with
 * exact last_read per thread. Threads absent from a complete view that we
 * thought were unread are marked read. Threads active inside the thread window
 * get their full replies queued for backfill.
 */
export const reconcileThreads = (cfg: SyncConfig = defaultSyncConfig) => Effect.gen(function* () {
  const repo = yield* Store
  const threadSince = millisToTs(Date.now() - cfg.threadWindowMs)
  const seen = new Set<string>()
  const newMessages: Reduced["newMessages"] = []
  const readMoved: Reduced["readMoved"] = []
  let maxTs: string | undefined
  let complete = false
  for (let page = 0; page < 20; page++) {
    let pageHasUnread = false
    const view = yield* Api.threadView(50, maxTs)
    repo.sql.transaction(() => {
      for (const t of view.threads) {
        const ch = t.root_msg.channel
        if (!ch) continue
        const root = t.root_msg
        seen.add(`${ch}:${root.ts}`)
        if (repo.upsertMessage(ch, root)) newMessages.push({ conversationId: ch, ts: root.ts, threadTs: root.ts })
        for (const m of [...(t.latest_replies ?? []), ...(t.unread_replies ?? [])]) {
          if (repo.upsertMessage(ch, m)) newMessages.push({ conversationId: ch, ts: m.ts, threadTs: m.thread_ts ?? root.ts })
        }
        if (repo.patchThreadRead(ch, root.ts, { subscribed: root.subscribed ?? true, last_read: root.last_read, unread_count: t.unread_replies?.length ?? 0 }, "getView") && root.last_read)
          readMoved.push({ conversationId: ch, threadTs: root.ts, lastRead: root.last_read })
        const latest = root.latest_reply ?? root.ts
        const unread = (t.unread_replies?.length ?? 0) > 0 || tsGt(latest, root.last_read)
        pageHasUnread ||= unread
        if ((unread || latest > threadSince) && threadNeedsFill(repo, ch, root.ts, latest)) queueThread(repo, ch, root.ts)
      }
    })
    const last = view.threads.at(-1)?.root_msg
    if (!view.has_more || !last) {
      complete = true
      break
    }
    maxTs = last.latest_reply ?? last.ts
    // Older pages only matter while they still contain unread threads.
    if (maxTs < threadSince && !pageHasUnread) break
  }
  // Unread threads past the pages we walked (e.g. from thread_marked events) still get fetched in full.
  for (const t of repo.sql.all<{ conversation_id: string; thread_ts: string }>(
    `SELECT t.conversation_id, t.thread_ts FROM thread_reads t LEFT JOIN thread_sync s USING (conversation_id, thread_ts)
     WHERE t.subscribed = 1 AND coalesce(t.unread_count, 0) > 0 AND coalesce(s.full, 0) = 0 AND coalesce(s.done, 0) = 0`,
  )) queueThread(repo, t.conversation_id, t.thread_ts)
  if (complete) {
    // Any thread we still believe unread but is not in the full view was read elsewhere.
    const believedUnread = repo.sql.all<{ conversation_id: string; thread_ts: string }>(
      "SELECT conversation_id, thread_ts FROM thread_reads WHERE subscribed = 1 AND coalesce(unread_count, 0) > 0",
    )
    repo.sql.transaction(() => {
      for (const t of believedUnread) {
        if (seen.has(`${t.conversation_id}:${t.thread_ts}`)) continue
        repo.patchThreadRead(t.conversation_id, t.thread_ts, { unread_count: 0 }, "getView:absent")
        readMoved.push({ conversationId: t.conversation_id, threadTs: t.thread_ts, lastRead: "" })
      }
    })
  }
  return { threads: seen.size, newMessages, readMoved, complete }
}).pipe(Effect.withSpan("sync.reconcileThreads"))

/** One history page, waiting out rate limits instead of aborting the whole reconcile pass. */
const historyPage = (conversationId: string, p: Parameters<typeof Api.history>[1]) =>
  Api.history(conversationId, p).pipe(
    Effect.catchTag("SlackRateLimited", (e) => Effect.sleep(e.retryAfterMs).pipe(Effect.zipRight(Api.history(conversationId, p)))),
    Effect.retry({ times: 3, while: (e) => e._tag === "SlackRateLimited" }),
  )

const storedAtOrBefore = (repo: Repo, conversationId: string, ts: string) =>
  repo.sql.all("SELECT 1 FROM messages WHERE conversation_id = ? AND ts <= ? LIMIT 1", conversationId, ts).length > 0

/** Page conversations.history (newest first) over (oldest, latest]; reports the span fetched. */
const fetchDown = (repo: Repo, conversationId: string, oldest: string, latest: string | undefined, maxPages: number) =>
  Effect.gen(function* () {
    const newMessages: Reduced["newMessages"] = []
    const threads: string[] = []
    let min: string | null = null
    let max: string | null = null
    let cursor: string | undefined
    let complete = false
    let pages = 0
    for (; pages < maxPages; ) {
      pages++
      const res = yield* historyPage(conversationId, { oldest: Number(oldest) > 0 ? oldest : undefined, latest, cursor, inclusive: true })
      repo.sql.transaction(() => {
        for (const m of res.messages) {
          if (tsGt(m.ts, max)) max = m.ts
          if (min == null || m.ts < min) min = m.ts
          if (repo.upsertMessage(conversationId, m)) newMessages.push({ conversationId, ts: m.ts, threadTs: m.thread_ts ?? null })
          if (m.reply_count && m.latest_reply && tsGt(m.latest_reply, newestReply(repo, conversationId, m.ts))) threads.push(m.ts)
        }
      })
      cursor = res.response_metadata?.next_cursor ?? undefined
      if (!res.has_more || !cursor) {
        complete = true
        break
      }
    }
    for (const t of threads) queueThread(repo, conversationId, t)
    return { newMessages, complete, pages, min: min as string | null, max: max as string | null }
  })

/**
 * Bring one conversation's contiguous history range to [historyTarget, now]: first fetch
 * what's newer than its top, then extend its bottom down to the target. Big gaps resume
 * next pass (the range stays contiguous because history pages run newest first).
 */
export const fillConversation = (conversationId: string, cfg: SyncConfig = defaultSyncConfig) =>
  Effect.gen(function* () {
    const repo = yield* Store
    const target = historyTarget(cfg, repo, conversationId)
    const w = watermark(repo, conversationId)
    const fresh = !w?.newest_ts || w.newest_ts < target
    let from = fresh ? target : (w.oldest_ts ?? w.newest_ts!)
    let through = fresh ? target : w.newest_ts!
    const newMessages: Reduced["newMessages"] = []
    const top = yield* fetchDown(repo, conversationId, through, undefined, cfg.maxPagesPerFill)
    newMessages.push(...top.newMessages)
    if (top.complete) through = tsGt(top.max, through) ? top.max! : through
    else [from, through] = [top.min!, top.max!]

    if (tsGt(from, target)) {
      const bottom = yield* fetchDown(repo, conversationId, target, from, cfg.maxPagesPerFill)
      newMessages.push(...bottom.newMessages)
      from = bottom.complete ? target : (bottom.min ?? from)
    }
    // Also store the message at/before the target (the last read one), so stored history visibly reaches last_read.
    if (from === target && Number(target) > 0 && !storedAtOrBefore(repo, conversationId, target)) {
      const anchor = yield* historyPage(conversationId, { latest: target, inclusive: true, limit: 1 })
      repo.sql.transaction(() => anchor.messages.forEach((m) => repo.upsertMessage(conversationId, m)))
      from = anchor.messages[0]?.ts ?? "0000000000.000000"
    }
    setRange(repo, conversationId, from, through)
    return { newMessages, complete: from <= target }
  }).pipe(
    Effect.catchTag("SlackApiError", (e) =>
      Effect.flatMap(Store, (repo) => Effect.sync(() => setFillError(repo, conversationId, e.error))).pipe(
        Effect.zipRight(Effect.logWarning(`history ${conversationId}: ${e.error}`)),
        Effect.as({ newMessages: [] as Reduced["newMessages"], complete: false }),
      ),
    ),
    Effect.withSpan("sync.fillConversation", { attributes: { conversationId } }),
  )

const newestReply = (repo: Repo, conversationId: string, threadTs: string): string | null =>
  repo.sql.all<{ ts: string | null }>(
    "SELECT max(ts) AS ts FROM messages WHERE conversation_id = ? AND thread_ts = ? AND ts != thread_ts", conversationId, threadTs,
  )[0]?.ts ?? null

export const queueThread = (repo: Repo, conversationId: string, threadTs: string) =>
  repo.sql.run(
    `INSERT INTO thread_sync (conversation_id, thread_ts, done, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(conversation_id, thread_ts) DO UPDATE SET done = 0, updated_at = excluded.updated_at`,
    conversationId, threadTs, Date.now(),
  )

/** A thread needs replies fetched until it was fetched in full once, and again when newer replies exist. */
const threadNeedsFill = (repo: Repo, conversationId: string, threadTs: string, latest: string): boolean => {
  const row = repo.sql.all<{ full: number; newest_ts: string | null }>(
    "SELECT full, newest_ts FROM thread_sync WHERE conversation_id = ? AND thread_ts = ?", conversationId, threadTs,
  )[0]
  return !row?.full || tsGt(latest, row.newest_ts ?? newestReply(repo, conversationId, threadTs))
}

/**
 * Fetch replies for queued threads (unread first). The first fetch reads the whole thread
 * (paged, resumable via thread_sync.cursor); later fetches only replies after newest_ts.
 */
export const fillThreads = (cfg: SyncConfig = defaultSyncConfig) =>
  Effect.gen(function* () {
    const repo = yield* Store
    const pending = repo.sql.all<{ conversation_id: string; thread_ts: string; full: number; newest_ts: string | null; cursor: string | null }>(
      `SELECT s.conversation_id, s.thread_ts, s.full, s.newest_ts, s.cursor FROM thread_sync s
       LEFT JOIN thread_reads r ON r.conversation_id = s.conversation_id AND r.thread_ts = s.thread_ts
       WHERE s.done = 0 ORDER BY coalesce(r.unread_count, 0) > 0 DESC, s.updated_at LIMIT ?`, cfg.maxThreadsPerPass,
    )
    const newMessages: Reduced["newMessages"] = []
    for (const t of pending) {
      const oldest = t.full ? (t.newest_ts ?? undefined) : undefined
      let cursor = t.cursor ?? undefined
      let complete = false
      for (let page = 0; page < cfg.maxPagesPerFill; page++) {
        const res = yield* Api.replies(t.conversation_id, t.thread_ts, { oldest, cursor }).pipe(
          Effect.catchTag("SlackApiError", () => Effect.succeed(undefined)),
        )
        repo.sql.transaction(() => {
          for (const m of res?.messages ?? []) {
            if (repo.upsertMessage(t.conversation_id, m)) newMessages.push({ conversationId: t.conversation_id, ts: m.ts, threadTs: m.thread_ts ?? null })
          }
        })
        cursor = res?.response_metadata?.next_cursor ?? undefined
        if (!res || !res.has_more || !cursor) {
          complete = true
          break
        }
      }
      repo.sql.run(
        complete
          ? "UPDATE thread_sync SET done = 1, full = 1, cursor = NULL, newest_ts = ?, updated_at = ? WHERE conversation_id = ? AND thread_ts = ?"
          : "UPDATE thread_sync SET cursor = ?, updated_at = ? WHERE conversation_id = ? AND thread_ts = ?",
        complete ? newestReply(repo, t.conversation_id, t.thread_ts) : (cursor ?? null), Date.now(), t.conversation_id, t.thread_ts,
      )
    }
    return { threads: pending.length, newMessages }
  }).pipe(Effect.withSpan("sync.fillThreads"))

/** Fetch metadata for conversations/users seen in events but not known yet. */
export const fillUnknown = (conversations: ReadonlyArray<string>, users: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repo = yield* Store
    for (const id of new Set(conversations)) {
      const info = yield* Api.conversationInfo(id).pipe(Effect.option)
      if (info._tag === "Some") repo.upsertConversation(info.value.channel)
    }
    for (const id of new Set(users)) {
      const info = yield* Api.userInfo(id).pipe(Effect.option)
      if (info._tag === "Some") repo.upsertUser(info.value.user)
    }
  })

/** users.list for the home workspace (Slack Connect users come via users.info). */
export const syncUsers = Effect.gen(function* () {
  const repo = yield* Store
  let cursor: string | undefined
  let n = 0
  for (let page = 0; page < 50; page++) {
    const res = yield* Api.usersList(cursor)
    repo.sql.transaction(() => res.members.forEach((u) => repo.upsertUser(u)))
    n += res.members.length
    cursor = res.response_metadata?.next_cursor ?? undefined
    if (!cursor) break
  }
  return n
}).pipe(Effect.withSpan("sync.users"))

/**
 * One reconcile pass: counts (read state + gap detection), threads view,
 * bounded history gap-fill for the stalest conversations, queued threads.
 */
export const reconcile = (cfg: SyncConfig = defaultSyncConfig) =>
  Effect.gen(function* () {
    const repo = yield* Store
    const counts = yield* reconcileCounts(cfg)
    const threads = yield* reconcileThreads(cfg)
    const newMessages = [...threads.newMessages]
    const readMoved = [...counts.readMoved, ...threads.readMoved]
    const stale = counts.stale.slice(0, cfg.maxConversationsPerPass)
    let unfinished = 0
    for (const id of stale) {
      const r = yield* fillConversation(id, cfg)
      newMessages.push(...r.newMessages)
      if (!r.complete) unfinished++
    }
    const t = yield* fillThreads(cfg)
    newMessages.push(...t.newMessages)
    const threadsPending = repo.sql.all<{ n: number }>("SELECT count(*) AS n FROM thread_sync WHERE done = 0")[0]?.n ?? 0
    return {
      newMessages, readMoved,
      staleRemaining: counts.stale.length - stale.length + unfinished + threadsPending,
      filled: stale.length, threadsFilled: t.threads, unreadThreads: threads.threads,
    }
  }).pipe(Effect.withSpan("sync.reconcile"))
