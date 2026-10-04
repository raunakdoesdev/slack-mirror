import { Context, Effect, Layer } from "effect"
import type * as Slack from "../slack/schema.ts"
import { ZERO_TS } from "../slack/ts.ts"
import { migrate } from "./migrations.ts"
import { first, SqlDb, type Sql } from "./sql.ts"

export type ConversationKind = "channel" | "private" | "im" | "mpim"

export const conversationKind = (c: Slack.Conversation): ConversationKind =>
  c.is_im ? "im" : c.is_mpim ? "mpim" : c.is_private || c.is_group ? "private" : c.id.startsWith("D") ? "im" : "channel"

const HIDDEN_SUBTYPES = new Set([
  "channel_join", "channel_leave", "group_join", "group_leave", "channel_topic", "channel_purpose",
  "channel_name", "channel_archive", "channel_unarchive", "bot_add", "bot_remove", "pinned_item", "unpinned_item",
])
/** Subtypes that Slack does not count toward unread badges. */
export const isSilentSubtype = (subtype: string | null | undefined): boolean =>
  subtype != null && HIDDEN_SUBTYPES.has(subtype)

export interface Identity {
  readonly selfUserId: string
  readonly teamId: string
  readonly groupIds: ReadonlyArray<string>
}

export interface MessageRow {
  readonly id: number
  readonly conversation_id: string
  readonly ts: string
  readonly thread_ts: string | null
  readonly is_reply: number
  readonly is_broadcast: number
  readonly user_id: string | null
  readonly bot_id: string | null
  readonly subtype: string | null
  readonly text: string | null
  readonly reply_count: number | null
  readonly latest_reply: string | null
  readonly deleted: number
  readonly edited_ts: string | null
}

export interface ChannelReadRow {
  readonly conversation_id: string
  readonly last_read: string | null
  readonly latest: string | null
  readonly has_unreads: number
  readonly unread_count: number | null
  readonly unread_count_display: number | null
  readonly mention_count: number | null
  readonly source: string | null
  readonly updated_at: number
}

export interface ThreadReadRow {
  readonly conversation_id: string
  readonly thread_ts: string
  readonly subscribed: number
  readonly last_read: string | null
  readonly unread_count: number | null
  readonly source: string | null
  readonly updated_at: number
}

export interface ConversationRow {
  readonly id: string
  readonly kind: ConversationKind
  readonly name: string | null
  readonly im_user_id: string | null
  readonly is_muted: number
  readonly is_archived: number
  readonly is_ext_shared: number
  readonly is_member: number
}

export interface UserRow {
  readonly id: string
  readonly name: string | null
  readonly real_name: string | null
  readonly display_name: string | null
  readonly is_bot: number
}

export type ChannelReadPatch = {
  readonly last_read?: string | null | undefined
  readonly latest?: string | null | undefined
  readonly has_unreads?: boolean | null | undefined
  readonly unread_count?: number | null | undefined
  readonly unread_count_display?: number | null | undefined
  readonly mention_count?: number | null | undefined
}

export type ThreadReadPatch = {
  readonly subscribed?: boolean | null | undefined
  readonly last_read?: string | null | undefined
  readonly unread_count?: number | null | undefined
}

/**
 * Synchronous repository over SQLite. All writes are idempotent so that
 * realtime events, gap fills and backfills can overlap freely.
 */
export const makeRepo = (sql: Sql) => {
  const now = () => Date.now()

  const getMeta = (key: string): string | undefined =>
    first(sql.all<{ value: string }>("SELECT value FROM meta WHERE key = ?", key))?.value
  const setMeta = (key: string, value: string | null) =>
    value === null
      ? sql.run("DELETE FROM meta WHERE key = ?", key)
      : sql.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)

  const identity = (): Identity | undefined => {
    const selfUserId = getMeta("self_user_id")
    const teamId = getMeta("team_id")
    if (!selfUserId || !teamId) return undefined
    return { selfUserId, teamId, groupIds: JSON.parse(getMeta("self_group_ids") ?? "[]") as string[] }
  }

  const setIdentity = (id: Identity, team: { name?: string | null; domain?: string | null; enterprise_id?: string | null }) => {
    setMeta("self_user_id", id.selfUserId)
    setMeta("team_id", id.teamId)
    setMeta("self_group_ids", JSON.stringify(id.groupIds))
    sql.run(
      `INSERT INTO workspaces (id, name, domain, enterprise_id, self_user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = coalesce(excluded.name, name), domain = coalesce(excluded.domain, domain),
         enterprise_id = coalesce(excluded.enterprise_id, enterprise_id), self_user_id = excluded.self_user_id, updated_at = excluded.updated_at`,
      id.teamId, team.name, team.domain, team.enterprise_id, id.selfUserId, now(),
    )
  }

  const upsertUser = (u: Slack.User) =>
    sql.run(
      `INSERT INTO users (id, team_id, name, real_name, display_name, email, is_bot, is_external, deleted, tz, raw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET team_id = excluded.team_id, name = excluded.name, real_name = excluded.real_name,
         display_name = excluded.display_name, email = excluded.email, is_bot = excluded.is_bot, is_external = excluded.is_external,
         deleted = excluded.deleted, tz = excluded.tz, raw = excluded.raw, updated_at = excluded.updated_at`,
      u.id, u.team_id, u.name, u.real_name ?? u.profile?.real_name, u.profile?.display_name, u.profile?.email,
      !!u.is_bot, !!u.is_stranger || (u.team_id != null && u.team_id !== getMeta("team_id")), !!u.deleted, u.tz, JSON.stringify(u), now(),
    )

  const ensureUserStub = (userId: string | null | undefined) => {
    if (!userId) return
    sql.run("INSERT OR IGNORE INTO users (id, updated_at) VALUES (?, 0)", userId)
  }

  const upsertConversation = (c: Slack.Conversation, opts: { member?: boolean } = {}) => {
    const kind = conversationKind(c)
    sql.run(
      `INSERT INTO conversations (id, team_id, kind, name, im_user_id, is_archived, is_member, is_shared, is_ext_shared, topic, purpose, created, raw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET team_id = coalesce(excluded.team_id, team_id), kind = excluded.kind,
         name = coalesce(excluded.name, name), im_user_id = coalesce(excluded.im_user_id, im_user_id),
         is_archived = excluded.is_archived, is_member = excluded.is_member, is_shared = excluded.is_shared,
         is_ext_shared = excluded.is_ext_shared, topic = coalesce(excluded.topic, topic), purpose = coalesce(excluded.purpose, purpose),
         created = coalesce(excluded.created, created), raw = excluded.raw, updated_at = excluded.updated_at`,
      c.id, c.context_team_id, kind, c.name, c.user, !!c.is_archived, opts.member ?? c.is_member ?? true,
      !!c.is_shared || !!c.is_org_shared, !!c.is_ext_shared, c.topic?.value, c.purpose?.value, c.created, JSON.stringify(c), now(),
    )
    if (c.last_read) patchChannelRead(c.id, { last_read: c.last_read, unread_count: c.unread_count, unread_count_display: c.unread_count_display }, "conversations.info")
    if (kind === "im" && c.user) ensureUserStub(c.user)
  }

  /** Placeholder row for a conversation we only know by id (metadata is fetched later). */
  const ensureConversation = (id: string, member = true) => {
    const kind: ConversationKind = id.startsWith("D") ? "im" : id.startsWith("G") ? "private" : "channel"
    sql.run("INSERT OR IGNORE INTO conversations (id, kind, is_member, updated_at) VALUES (?, ?, ?, 0)", id, kind, member ? 1 : 0)
  }

  const conversation = (id: string): ConversationRow | undefined =>
    first(sql.all<ConversationRow>("SELECT id, kind, name, im_user_id, is_muted, is_archived, is_ext_shared, is_member FROM conversations WHERE id = ?", id))

  const setConversationField = (id: string, field: "name" | "is_archived" | "is_member", value: string | boolean) => {
    ensureConversation(id)
    sql.run(`UPDATE conversations SET ${field} = ?, updated_at = ? WHERE id = ?`, typeof value === "boolean" ? (value ? 1 : 0) : value, now(), id)
  }

  const setMuted = (mutedIds: ReadonlySet<string>) => {
    sql.run("UPDATE conversations SET is_muted = 0 WHERE is_muted = 1")
    for (const id of mutedIds) {
      ensureConversation(id)
      sql.run("UPDATE conversations SET is_muted = 1 WHERE id = ?", id)
    }
  }

  const setMembers = (conversationId: string, userIds: ReadonlyArray<string>, replace: boolean) => {
    if (replace) sql.run("DELETE FROM conversation_members WHERE conversation_id = ?", conversationId)
    for (const u of userIds) sql.run("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)", conversationId, u)
  }
  const removeMember = (conversationId: string, userId: string) =>
    sql.run("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?", conversationId, userId)

  const message = (conversationId: string, ts: string): MessageRow | undefined =>
    first(sql.all<MessageRow>("SELECT * FROM messages WHERE conversation_id = ? AND ts = ?", conversationId, ts))

  /** Insert or update a message. Returns true when the message is new. */
  const upsertMessage = (conversationId: string, m: Slack.Message): boolean => {
    ensureConversation(conversationId)
    const threadTs = m.thread_ts ?? (m.reply_count ? m.ts : null)
    const isBroadcast = m.subtype === "thread_broadcast"
    const isReply = threadTs != null && threadTs !== m.ts && !isBroadcast
    const existing = message(conversationId, m.ts)
    if (existing && m.edited?.ts && m.edited.ts !== existing.edited_ts) {
      sql.run(
        "INSERT OR IGNORE INTO message_edits (conversation_id, ts, edited_ts, previous_text, text) VALUES (?, ?, ?, ?, ?)",
        conversationId, m.ts, m.edited.ts, existing.text, m.text,
      )
    }
    sql.run(
      `INSERT INTO messages (conversation_id, ts, thread_ts, is_reply, is_broadcast, user_id, bot_id, subtype, text, reply_count,
         latest_reply, reply_users, edited_ts, raw, inserted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, ts) DO UPDATE SET thread_ts = excluded.thread_ts, is_reply = excluded.is_reply,
         is_broadcast = excluded.is_broadcast, user_id = coalesce(excluded.user_id, user_id), bot_id = coalesce(excluded.bot_id, bot_id),
         subtype = excluded.subtype, text = excluded.text, reply_count = coalesce(excluded.reply_count, reply_count),
         latest_reply = coalesce(excluded.latest_reply, latest_reply), reply_users = coalesce(excluded.reply_users, reply_users),
         edited_ts = coalesce(excluded.edited_ts, edited_ts), raw = excluded.raw,
         updated_at = excluded.updated_at`,
      conversationId, m.ts, threadTs, isReply, isBroadcast, m.user, m.bot_id, m.subtype, m.text, m.reply_count,
      m.latest_reply, m.reply_users ? JSON.stringify(m.reply_users) : null, m.edited?.ts, JSON.stringify(m), now(), now(),
    )
    ensureUserStub(m.user)
    if (m.reactions) {
      sql.run("DELETE FROM reactions WHERE conversation_id = ? AND ts = ?", conversationId, m.ts)
      for (const r of m.reactions) for (const u of r.users ?? []) addReaction(conversationId, m.ts, r.name, u)
    }
    for (const f of m.files ?? []) upsertFile(conversationId, m.ts, f)
    // Parent messages carry the user's per-thread subscription + read cursor.
    if (threadTs === m.ts && (m.subscribed != null || m.last_read != null)) {
      patchThreadRead(conversationId, m.ts, { subscribed: m.subscribed, last_read: m.last_read }, "message")
    }
    if (isReply && threadTs) bumpThreadParent(conversationId, threadTs, m.ts, m.user)
    return existing === undefined
  }

  const bumpThreadParent = (conversationId: string, threadTs: string, replyTs: string, user: string | null | undefined) => {
    const parent = message(conversationId, threadTs)
    if (!parent) return
    const users = new Set<string>(JSON.parse((first(sql.all<{ reply_users: string | null }>(
      "SELECT reply_users FROM messages WHERE id = ?", parent.id))?.reply_users) ?? "[]"))
    if (user) users.add(user)
    const replies = first(sql.all<{ n: number }>(
      "SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND thread_ts = ? AND is_reply = 1 AND deleted = 0", conversationId, threadTs))?.n ?? 0
    sql.run(
      `UPDATE messages SET thread_ts = ?, reply_count = max(coalesce(reply_count, 0), ?),
         latest_reply = CASE WHEN latest_reply IS NULL OR latest_reply < ? THEN ? ELSE latest_reply END, reply_users = ?, updated_at = ?
       WHERE id = ?`,
      threadTs, replies, replyTs, replyTs, JSON.stringify([...users]), now(), parent.id,
    )
  }

  const markDeleted = (conversationId: string, ts: string) => {
    ensureConversation(conversationId)
    const changed = sql.run("UPDATE messages SET deleted = 1, updated_at = ? WHERE conversation_id = ? AND ts = ?", now(), conversationId, ts)
    if (changed === 0) {
      sql.run(
        "INSERT INTO messages (conversation_id, ts, deleted, inserted_at, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT DO NOTHING",
        conversationId, ts, now(), now(),
      )
    }
  }

  const addReaction = (conversationId: string, ts: string, name: string, userId: string) =>
    sql.run("INSERT OR IGNORE INTO reactions (conversation_id, ts, name, user_id) VALUES (?, ?, ?, ?)", conversationId, ts, name, userId)
  const removeReaction = (conversationId: string, ts: string, name: string, userId: string) =>
    sql.run("DELETE FROM reactions WHERE conversation_id = ? AND ts = ? AND name = ? AND user_id = ?", conversationId, ts, name, userId)

  const upsertFile = (conversationId: string, ts: string, f: Slack.File) =>
    sql.run(
      `INSERT INTO files (id, conversation_id, ts, user_id, name, title, mimetype, filetype, size, permalink, url_private, created, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = coalesce(excluded.name, name), title = coalesce(excluded.title, title),
         mimetype = coalesce(excluded.mimetype, mimetype), size = coalesce(excluded.size, size), raw = excluded.raw`,
      f.id, conversationId, ts, f.user, f.name, f.title, f.mimetype, f.filetype, f.size, f.permalink, f.url_private, f.created, JSON.stringify(f),
    )
  const deleteFile = (fileId: string) => sql.run("DELETE FROM files WHERE id = ?", fileId)

  const channelRead = (conversationId: string): ChannelReadRow | undefined =>
    first(sql.all<ChannelReadRow>("SELECT * FROM channel_reads WHERE conversation_id = ?", conversationId))

  /** Applies a partial read-state update. Returns true if last_read moved forward. */
  const patchChannelRead = (conversationId: string, p: ChannelReadPatch, source: string): boolean => {
    const prev = channelRead(conversationId)
    const lastRead = p.last_read === undefined ? (prev?.last_read ?? null) : p.last_read
    const pick = <K extends keyof ChannelReadPatch & keyof ChannelReadRow>(k: K) =>
      p[k] === undefined ? (prev?.[k] ?? null) : p[k]
    sql.run(
      `INSERT INTO channel_reads (conversation_id, last_read, latest, has_unreads, unread_count, unread_count_display, mention_count, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET last_read = excluded.last_read, latest = excluded.latest, has_unreads = excluded.has_unreads,
         unread_count = excluded.unread_count, unread_count_display = excluded.unread_count_display, mention_count = excluded.mention_count,
         source = excluded.source, updated_at = excluded.updated_at`,
      conversationId, lastRead, pick("latest"), p.has_unreads == null ? (prev?.has_unreads ?? 0) : p.has_unreads, pick("unread_count"),
      pick("unread_count_display"), pick("mention_count"), source, now(),
    )
    return lastRead != null && (prev?.last_read == null || lastRead > prev.last_read)
  }

  const threadRead = (conversationId: string, threadTs: string): ThreadReadRow | undefined =>
    first(sql.all<ThreadReadRow>("SELECT * FROM thread_reads WHERE conversation_id = ? AND thread_ts = ?", conversationId, threadTs))

  const patchThreadRead = (conversationId: string, threadTs: string, p: ThreadReadPatch, source: string): boolean => {
    const prev = threadRead(conversationId, threadTs)
    const lastRead = p.last_read == null ? (prev?.last_read ?? null) : p.last_read
    const subscribed = p.subscribed == null ? (prev?.subscribed ?? 0) : p.subscribed ? 1 : 0
    const unread = p.unread_count === undefined ? (prev?.unread_count ?? null) : p.unread_count
    sql.run(
      `INSERT INTO thread_reads (conversation_id, thread_ts, subscribed, last_read, unread_count, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, thread_ts) DO UPDATE SET subscribed = excluded.subscribed, last_read = excluded.last_read,
         unread_count = excluded.unread_count, source = excluded.source, updated_at = excluded.updated_at`,
      conversationId, threadTs, subscribed, lastRead, unread, source, now(),
    )
    return lastRead != null && (prev?.last_read == null || lastRead > prev.last_read)
  }

  /** Whether the owner has read message `ts` (thread replies use the thread cursor). */
  const isRead = (conversationId: string, ts: string, threadTs: string | null): boolean => {
    const self = identity()?.selfUserId
    const m = message(conversationId, ts)
    if (m && self && m.user_id === self) return true
    const isReply = m ? m.is_reply === 1 : threadTs != null && threadTs !== ts
    if (isReply && threadTs) {
      const tr = threadRead(conversationId, threadTs)
      return tr?.last_read != null && tr.last_read !== ZERO_TS && tr.last_read >= ts
    }
    const cr = channelRead(conversationId)
    return cr?.last_read != null && cr.last_read >= ts
  }

  const logEvent = (source: string, e: { type?: unknown; subtype?: unknown; channel?: unknown; ts?: unknown }, raw: unknown) =>
    sql.run(
      "INSERT INTO events (received_at, source, type, subtype, conversation_id, ts, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      now(), source, String(e.type ?? "unknown"), typeof e.subtype === "string" ? e.subtype : null,
      typeof e.channel === "string" ? e.channel : null, typeof e.ts === "string" ? e.ts : null,
      typeof raw === "string" ? raw : JSON.stringify(raw),
    )

  const pruneEvents = (olderThanMs: number) => sql.run("DELETE FROM events WHERE received_at < ?", now() - olderThanMs)

  const sample = (method: string, body: unknown) =>
    sql.run(
      "INSERT INTO api_samples (method, captured_at, body) VALUES (?, ?, ?) ON CONFLICT(method) DO UPDATE SET captured_at = excluded.captured_at, body = excluded.body",
      method, now(), JSON.stringify(body),
    )

  const user = (id: string): UserRow | undefined =>
    first(sql.all<UserRow>("SELECT id, name, real_name, display_name, is_bot FROM users WHERE id = ?", id))

  return {
    sql, getMeta, setMeta, identity, setIdentity, upsertUser, ensureUserStub, upsertConversation, ensureConversation,
    conversation, setConversationField, setMuted, setMembers, removeMember, message, upsertMessage, markDeleted,
    addReaction, removeReaction, upsertFile, deleteFile, channelRead, patchChannelRead, threadRead, patchThreadRead,
    isRead, logEvent, pruneEvents, sample, user,
  }
}

export type Repo = ReturnType<typeof makeRepo>

export class Store extends Context.Tag("slack-mirror/Store")<Store, Repo>() {}

export const StoreLive = Layer.effect(
  Store,
  Effect.gen(function* () {
    const sql = yield* SqlDb
    yield* Effect.sync(() => migrate(sql))
    return makeRepo(sql)
  }),
)
