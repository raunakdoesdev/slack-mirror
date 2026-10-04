import type { Repo } from "../store/store.ts"

/**
 * Read model for agents: raw mirrored Slack fields, with ids resolved to names,
 * permalinks, offset cursors and bounded response sizes. No scoring or judgment.
 */

export class QueryError extends Error {}

const DAY = 24 * 3600_000
export const MAX_LIMIT = 200
export const MAX_BYTES = 60_000

/** Slack ts, unix seconds, ISO date, or a relative age like "90m", "48h", "14d". */
export const parseTime = (v: unknown): string | undefined => {
  if (v == null || v === "") return undefined
  const s = String(v).trim()
  if (/^\d{9,10}(\.\d+)?$/.test(s)) return Number(s).toFixed(6)
  const rel = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/.exec(s)
  if (rel) {
    const mult = { m: 60_000, h: 3600_000, d: DAY, w: 7 * DAY }[rel[2] as "m" | "h" | "d" | "w"]
    return ((Date.now() - Number(rel[1]) * mult) / 1000).toFixed(6)
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new QueryError(`cannot parse time "${s}" (use Slack ts, unix seconds, ISO date, or 48h/14d)`)
  return (t / 1000).toFixed(6)
}

/** Backwards-compatible helper: parse `since` or fall back to now - fallbackMs. */
export const parseSince = (v: string | null | undefined, fallbackMs: number): string =>
  parseTime(v) ?? ((Date.now() - fallbackMs) / 1000).toFixed(6)

export const isoOf = (ts: string | null | undefined) => (ts ? new Date(Number(ts) * 1000).toISOString() : null)

const clampLimit = (v: unknown, d: number) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : d
}
const offsetOf = (cursor: unknown) => {
  const n = Number(cursor ?? 0)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/**
 * Page of rows fetched with LIMIT limit+1 at `offset`. Drops trailing rows until the
 * JSON fits MAX_BYTES; next_cursor then resumes right after the last returned row.
 */
export const page = <T>(rows: T[], limit: number, offset: number, extra: Record<string, unknown> = {}) => {
  let items = rows.slice(0, limit)
  let more = rows.length > limit
  while (items.length > 1 && JSON.stringify(items).length > MAX_BYTES) {
    items = items.slice(0, Math.max(1, Math.floor(items.length * 0.75)))
    more = true
  }
  return { ...extra, count: items.length, items, next_cursor: more ? String(offset + items.length) : null, truncated: more }
}

// ---------- names, text, permalinks ----------

interface Names {
  readonly self: string | undefined
  readonly user: (id: string | null | undefined) => string | null
  readonly channel: (id: string) => string | null
  readonly permalink: (conversationId: string, ts: string, threadTs?: string | null) => string | null
  readonly text: (t: string | null | undefined, max: number) => string | null
}

export const names = (repo: Repo): Names => {
  const users = new Map<string, string>()
  for (const u of repo.sql.all<{ id: string; n: string | null }>(
    "SELECT id, coalesce(nullif(display_name, ''), nullif(real_name, ''), name) AS n FROM users WHERE name IS NOT NULL OR real_name IS NOT NULL",
  )) if (u.n) users.set(u.id, u.n)
  const chans = new Map<string, string>()
  for (const c of repo.sql.all<{ id: string; name: string | null }>("SELECT id, name FROM conversations WHERE name IS NOT NULL")) if (c.name) chans.set(c.id, c.name)
  const domain = repo.sql.all<{ domain: string | null }>("SELECT domain FROM workspaces WHERE id = (SELECT value FROM meta WHERE key = 'team_id')")[0]?.domain
  const base = domain ? `https://${domain}.slack.com` : null
  const user = (id: string | null | undefined) => (id ? users.get(id) ?? null : null)
  return {
    self: repo.identity()?.selfUserId,
    user,
    channel: (id) => chans.get(id) ?? null,
    permalink: (c, ts, threadTs) =>
      base ? `${base}/archives/${c}/p${ts.replace(".", "")}${threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${c}` : ""}` : null,
    text: (t, max) => {
      if (t == null) return null
      const out = t
        .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (m, id: string) => (users.has(id) ? `<@${id}|${users.get(id)}>` : m))
        .replace(/<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>/g, (m, id: string) => (chans.has(id) ? `<#${id}|${chans.get(id)}>` : m))
      return out.length > max ? `${out.slice(0, max)}…[+${out.length - max} chars]` : out
    },
  }
}

// ---------- conversations ----------

export type ConversationType = "channel" | "private" | "im" | "mpim" | "shared" | "ext_shared"
const TYPES: ReadonlyArray<ConversationType> = ["channel", "private", "im", "mpim", "shared", "ext_shared"]

const typeFilter = (types: ReadonlyArray<string>, alias = "c") => {
  const bad = types.filter((t) => !TYPES.includes(t as ConversationType))
  if (bad.length) throw new QueryError(`unknown type ${bad.join(",")} (use ${TYPES.join("|")})`)
  const parts = types.map((t) =>
    t === "ext_shared" ? `${alias}.is_ext_shared = 1` : t === "shared" ? `(${alias}.is_shared = 1 OR ${alias}.is_ext_shared = 1)` : `${alias}.kind = '${t}'`)
  return parts.length ? `AND (${parts.join(" OR ")})` : ""
}

const list = (v: unknown): string[] =>
  v == null || v === "" ? [] : (Array.isArray(v) ? v.map(String) : String(v).split(",")).map((s) => s.trim()).filter(Boolean)

export const findConversation = (repo: Repo, nameOrId: string): string | undefined => {
  const v = nameOrId.trim().replace(/^#/, "")
  return repo.sql.all<{ id: string }>(
    `SELECT id FROM conversations WHERE id = ? OR name = ?
     UNION ALL SELECT c.id FROM conversations c JOIN users u ON u.id = c.im_user_id WHERE c.kind = 'im' AND (u.name = ? OR u.display_name = ? OR u.real_name = ? OR u.email = ?)
     LIMIT 1`,
    v, v, v, v, v, v.toLowerCase(),
  )[0]?.id
}

export const resolveConversation = (repo: Repo, v: unknown): string => {
  if (typeof v !== "string" || !v) throw new QueryError("channel is required (id, #name, or a DM user's name/email)")
  const id = findConversation(repo, v)
  if (!id) throw new QueryError(`unknown conversation "${v}"`)
  return id
}

interface ConvRow {
  id: string; kind: string; name: string | null; im_user_id: string | null; is_archived: number; is_member: number
  is_shared: number; is_ext_shared: number; is_muted: number; topic: string | null; purpose: string | null; team_id: string | null
  last_read: string | null; latest: string | null; has_unreads: number | null; unread_count_display: number | null
  mention_count: number | null; read_source: string | null; last_message_ts: string | null; my_last_post_ts: string | null
  member_ids: string | null; history_newest_ts: string | null; history_oldest_ts: string | null
}

const CONV_SELECT = `SELECT c.id, c.kind, c.name, c.im_user_id, c.is_archived, c.is_member, c.is_shared, c.is_ext_shared, c.is_muted,
    c.topic, c.purpose, c.team_id, r.last_read, r.latest, r.has_unreads, r.unread_count_display, r.mention_count, r.source AS read_source,
    (SELECT max(ts) FROM messages m WHERE m.conversation_id = c.id AND m.deleted = 0) AS last_message_ts,
    (SELECT max(ts) FROM messages m WHERE m.conversation_id = c.id AND m.user_id = (SELECT value FROM meta WHERE key = 'self_user_id')) AS my_last_post_ts,
    (SELECT group_concat(user_id) FROM (SELECT user_id FROM conversation_members cm WHERE cm.conversation_id = c.id LIMIT 50)) AS member_ids,
    (SELECT newest_ts FROM sync_state s WHERE s.conversation_id = c.id) AS history_newest_ts,
    (SELECT coalesce(oldest_ts, newest_ts) FROM sync_state s WHERE s.conversation_id = c.id) AS history_oldest_ts
  FROM conversations c LEFT JOIN channel_reads r ON r.conversation_id = c.id`

const memberCount = (repo: Repo, id: string) =>
  repo.sql.all<{ n: number }>("SELECT count(*) AS n FROM conversation_members WHERE conversation_id = ?", id)[0]?.n ?? 0

const convOut = (repo: Repo, n: Names, c: ConvRow) => {
  const members = c.member_ids ? c.member_ids.split(",") : c.im_user_id ? [c.im_user_id] : []
  const display = c.kind === "im" ? (n.user(c.im_user_id) ?? c.im_user_id) : c.name
  return {
    id: c.id,
    name: display,
    type: c.kind,
    is_shared: !!c.is_shared,
    is_ext_shared: !!c.is_ext_shared,
    is_archived: !!c.is_archived,
    is_member: !!c.is_member,
    is_muted: !!c.is_muted,
    ...(c.topic ? { topic: c.topic } : {}),
    members: members.map((id) => ({ id, name: n.user(id) })),
    member_count: c.member_ids ? memberCount(repo, c.id) : members.length,
    // Slack's own read state (client.counts / *_marked events).
    last_read: c.last_read,
    latest: c.latest,
    has_unreads: c.has_unreads == null ? null : !!c.has_unreads,
    unread_count_display: c.unread_count_display,
    mention_count: c.mention_count,
    last_message_ts: c.last_message_ts,
    last_activity: isoOf(c.latest && (!c.last_message_ts || c.latest > c.last_message_ts) ? c.latest : c.last_message_ts),
    my_last_post_ts: c.my_last_post_ts,
    // Contiguous stored history: every message with from <= ts <= through is in the mirror.
    history: { from: c.history_oldest_ts, through: c.history_newest_ts },
    permalink: base(n, c.id),
  }
}
const base = (n: Names, id: string) => n.permalink(id, "0.0")?.replace(/\/p00$/, "") ?? null

export const listConversations = (repo: Repo, a: Record<string, unknown>) => {
  const limit = clampLimit(a.limit, 50)
  const offset = offsetOf(a.cursor)
  const since = parseTime(a.active_since ?? a.since)
  const until = parseTime(a.until)
  const where: string[] = []
  const params: unknown[] = []
  if (a.include_non_member !== true) where.push("c.is_member = 1")
  if (a.include_archived !== true) where.push("c.is_archived = 0")
  if (a.include_muted === false) where.push("c.is_muted = 0")
  if (a.unread === true) where.push("r.has_unreads = 1")
  if (typeof a.query === "string" && a.query) {
    where.push(`(c.name LIKE ? OR c.id = ? OR c.im_user_id IN (SELECT id FROM users WHERE name LIKE ? OR real_name LIKE ? OR display_name LIKE ? OR email LIKE ?))`)
    const q = `%${a.query.replace(/^#/, "")}%`
    params.push(q, a.query, q, q, q, q)
  }
  const activity = "max(coalesce(r.latest, '0'), coalesce((SELECT max(ts) FROM messages m WHERE m.conversation_id = c.id), '0'))"
  if (since) { where.push(`${activity} >= ?`); params.push(since) }
  if (until) { where.push(`${activity} <= ?`); params.push(until) }
  const n = names(repo)
  const rows = repo.sql.all<ConvRow>(
    `${CONV_SELECT} WHERE 1 = 1 ${where.length ? `AND ${where.join(" AND ")}` : ""} ${typeFilter(list(a.type))}
     ORDER BY ${activity} DESC, c.id LIMIT ? OFFSET ?`,
    ...params, limit + 1, offset,
  )
  return page(rows.map((c) => convOut(repo, n, c)), limit, offset)
}

export const conversationHeader = (repo: Repo, n: Names, id: string) => {
  const c = repo.sql.all<ConvRow>(`${CONV_SELECT} WHERE c.id = ?`, id)[0]
  if (!c) throw new QueryError(`unknown conversation ${id}`)
  return convOut(repo, n, c)
}

// ---------- messages ----------

interface MsgRow {
  conversation_id: string; ts: string; thread_ts: string | null; is_reply: number; is_broadcast: number; user_id: string | null
  bot_id: string | null; subtype: string | null; text: string | null; reply_count: number | null; latest_reply: string | null
  reply_users: string | null; edited_ts: string | null; deleted: number; raw: string | null
}

const MSG_COLS = `m.conversation_id, m.ts, m.thread_ts, m.is_reply, m.is_broadcast, m.user_id, m.bot_id, m.subtype, m.text,
  m.reply_count, m.latest_reply, m.reply_users, m.edited_ts, m.deleted, m.raw`

const attachments = (repo: Repo, rows: ReadonlyArray<MsgRow>) => {
  const reactions = new Map<string, Array<{ name: string; users: string[] }>>()
  const files = new Map<string, Array<Record<string, unknown>>>()
  const byConv = new Map<string, string[]>()
  for (const r of rows) (byConv.get(r.conversation_id) ?? byConv.set(r.conversation_id, []).get(r.conversation_id)!).push(r.ts)
  for (const [c, tss] of byConv) {
    for (let i = 0; i < tss.length; i += 90) {
      const chunk = tss.slice(i, i + 90)
      const qs = chunk.map(() => "?").join(",")
      for (const r of repo.sql.all<{ ts: string; name: string; user_id: string }>(
        `SELECT ts, name, user_id FROM reactions WHERE conversation_id = ? AND ts IN (${qs}) ORDER BY rowid`, c, ...chunk)) {
        const k = `${c}:${r.ts}`
        const list = reactions.get(k) ?? reactions.set(k, []).get(k)!
        const e = list.find((x) => x.name === r.name) ?? (list.push({ name: r.name, users: [] }), list.at(-1)!)
        e.users.push(r.user_id)
      }
      for (const f of repo.sql.all<{ ts: string; id: string; name: string | null; title: string | null; mimetype: string | null; filetype: string | null; size: number | null; permalink: string | null }>(
        `SELECT ts, id, name, title, mimetype, filetype, size, permalink FROM files WHERE conversation_id = ? AND ts IN (${qs})`, c, ...chunk)) {
        const k = `${c}:${f.ts}`
        const { ts: _ts, ...rest } = f
        ;(files.get(k) ?? files.set(k, []).get(k)!).push(rest)
      }
    }
  }
  return { reactions, files }
}

const msgOut = (n: Names, att: ReturnType<typeof attachments>, m: MsgRow, maxText: number, withChannel: boolean) => {
  const k = `${m.conversation_id}:${m.ts}`
  const raw = m.raw ? (JSON.parse(m.raw) as { username?: string; bot_profile?: { name?: string }; attachments?: unknown[]; blocks?: unknown[] }) : {}
  const replyUsers = m.reply_users ? (JSON.parse(m.reply_users) as string[]) : []
  const rx = att.reactions.get(k)
  const fs = att.files.get(k)
  return {
    ...(withChannel ? { channel: { id: m.conversation_id, name: n.channel(m.conversation_id) } } : {}),
    ts: m.ts,
    time: isoOf(m.ts),
    ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
    ...(m.is_reply ? { is_reply: true } : {}),
    ...(m.is_broadcast ? { is_broadcast: true } : {}),
    user: m.user_id,
    user_name: n.user(m.user_id) ?? raw.username ?? raw.bot_profile?.name ?? null,
    ...(m.bot_id ? { bot_id: m.bot_id } : {}),
    ...(m.subtype ? { subtype: m.subtype } : {}),
    text: m.deleted ? null : n.text(m.text, maxText),
    ...(m.deleted ? { deleted: true } : {}),
    ...(m.edited_ts ? { edited_ts: m.edited_ts } : {}),
    ...(m.reply_count ? { reply_count: m.reply_count, latest_reply: m.latest_reply, reply_users: replyUsers.map((id) => ({ id, name: n.user(id) })) } : {}),
    ...(rx ? { reactions: rx.map((r) => ({ name: r.name, count: r.users.length, users: r.users.map((id) => n.user(id) ?? id) })) } : {}),
    ...(fs ? { files: fs } : {}),
    ...(raw.attachments?.length ? { attachments_count: raw.attachments.length } : {}),
    permalink: n.permalink(m.conversation_id, m.ts, m.thread_ts),
  }
}

const shape = (repo: Repo, n: Names, rows: MsgRow[], maxText: number, withChannel: boolean) => {
  const att = attachments(repo, rows)
  return rows.map((m) => msgOut(n, att, m, maxText, withChannel))
}

const botClause = (a: Record<string, unknown>) =>
  a.include_bots === true ? "" : "AND m.bot_id IS NULL AND coalesce(m.subtype, '') NOT IN ('bot_message') AND coalesce((SELECT is_bot FROM users bu WHERE bu.id = m.user_id), 0) = 0"
const systemClause = "AND coalesce(m.subtype, '') NOT IN ('channel_join','channel_leave','group_join','group_leave','channel_topic','channel_purpose','channel_name')"

/** Top-level messages of a conversation, newest first; optional inline replies. */
export const getConversation = (repo: Repo, a: Record<string, unknown>) => {
  const id = resolveConversation(repo, a.channel)
  const limit = clampLimit(a.limit, 50)
  const offset = offsetOf(a.cursor)
  const since = parseTime(a.since)
  const until = parseTime(a.until)
  const maxText = clampText(a.max_text, 4000)
  const n = names(repo)
  const rows = repo.sql.all<MsgRow>(
    `SELECT ${MSG_COLS} FROM messages m WHERE m.conversation_id = ? AND m.is_reply = ${a.include_replies === true ? "m.is_reply" : "0"}
       ${since ? "AND m.ts >= ?" : ""} ${until ? "AND m.ts <= ?" : ""} ${a.include_bots === false ? botClause(a) : ""} ${a.include_system === true ? "" : systemClause}
     ORDER BY m.ts DESC LIMIT ? OFFSET ?`,
    id, ...(since ? [since] : []), ...(until ? [until] : []), limit + 1, offset,
  )
  return page(shape(repo, n, rows, maxText, false), limit, offset, { conversation: conversationHeader(repo, n, id), order: "newest_first" })
}

/** A thread: parent then replies, oldest first, plus Slack's per-thread read state. */
export const getThread = (repo: Repo, a: Record<string, unknown>) => {
  const id = resolveConversation(repo, a.channel)
  const ts = parseTime(a.ts)
  if (!ts) throw new QueryError("ts (thread parent ts) is required")
  const limit = clampLimit(a.limit, 100)
  const offset = offsetOf(a.cursor)
  const maxText = clampText(a.max_text, 4000)
  const n = names(repo)
  const rows = repo.sql.all<MsgRow>(
    `SELECT ${MSG_COLS} FROM messages m WHERE m.conversation_id = ? AND (m.ts = ? OR m.thread_ts = ?) ORDER BY m.ts LIMIT ? OFFSET ?`,
    id, ts, ts, limit + 1, offset,
  )
  const read = repo.threadRead(id, ts)
  const parent = repo.message(id, ts)
  return page(shape(repo, n, rows, maxText, false), limit, offset, {
    conversation: { id, name: id.startsWith("D") ? n.user(repo.conversation(id)?.im_user_id) : n.channel(id), type: repo.conversation(id)?.kind ?? null },
    thread_ts: ts,
    permalink: n.permalink(id, ts),
    reply_count: parent?.reply_count ?? null,
    replies_stored: repo.sql.all<{ n: number }>("SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND thread_ts = ? AND is_reply = 1", id, ts)[0]?.n ?? 0,
    read_state: read ? { subscribed: !!read.subscribed, last_read: read.last_read, unread_count: read.unread_count, source: read.source } : null,
    order: "oldest_first",
  })
}

const clampText = (v: unknown, d: number) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(n, 40_000) : d
}

const ftsQuery = (q: string) =>
  /["*:()^]|\b(AND|OR|NOT|NEAR)\b/.test(q) ? q : q.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, "")}"`).join(" ")

const resolveUser = (repo: Repo, v: string): string => {
  const s = v.trim().replace(/^@/, "")
  const id = repo.sql.all<{ id: string }>(
    "SELECT id FROM users WHERE id = ? OR name = ? OR display_name = ? OR real_name = ? OR lower(email) = lower(?) LIMIT 1", s, s, s, s, s)[0]?.id
  if (!id) throw new QueryError(`unknown user "${v}"`)
  return id
}

/** FTS5 search (or a filtered scan when `query` is empty), newest first by default. */
export const search = (repo: Repo, a: Record<string, unknown>) => {
  const q = typeof a.query === "string" ? a.query.trim() : ""
  const limit = clampLimit(a.limit, 30)
  const offset = offsetOf(a.cursor)
  const since = parseTime(a.since)
  const until = parseTime(a.until)
  const maxText = clampText(a.max_text, 1000)
  const where: string[] = ["m.deleted = 0"]
  const params: unknown[] = []
  if (a.channel) { where.push("m.conversation_id = ?"); params.push(resolveConversation(repo, a.channel)) }
  if (a.from) { where.push("m.user_id = ?"); params.push(resolveUser(repo, String(a.from))) }
  if (a.mentions_me === true) {
    const self = repo.identity()?.selfUserId ?? ""
    where.push("(instr(m.text, ?) > 0 OR m.conversation_id IN (SELECT id FROM conversations WHERE kind = 'im'))")
    params.push(`<@${self}`)
  }
  if (a.mentions) { where.push("instr(m.text, ?) > 0"); params.push(`<@${resolveUser(repo, String(a.mentions))}`) }
  if (since) { where.push("m.ts >= ?"); params.push(since) }
  if (until) { where.push("m.ts <= ?"); params.push(until) }
  const types = typeFilter(list(a.type))
  const order = a.sort === "relevance" && q ? "rank" : "m.ts DESC"
  const n = names(repo)
  const rows = repo.sql.all<MsgRow & { snippet?: string }>(
    q
      ? `SELECT ${MSG_COLS}, snippet(messages_fts, 0, '[', ']', '…', 16) AS snippet FROM messages_fts f JOIN messages m ON m.id = f.rowid
         JOIN conversations c ON c.id = m.conversation_id WHERE messages_fts MATCH ? AND ${where.join(" AND ")} ${types} ${botClause(a)} ${systemClause}
         ORDER BY ${order} LIMIT ? OFFSET ?`
      : `SELECT ${MSG_COLS} FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE ${where.join(" AND ")} ${types} ${botClause(a)} ${systemClause} ORDER BY m.ts DESC LIMIT ? OFFSET ?`,
    ...(q ? [ftsQuery(q)] : []), ...params, limit + 1, offset,
  )
  const out = shape(repo, n, rows, maxText, true).map((m, i) => {
    const c = repo.conversation(rows[i]!.conversation_id)
    return { ...m, ...(rows[i]!.snippet ? { snippet: rows[i]!.snippet } : {}), channel: { id: rows[i]!.conversation_id, name: c?.kind === "im" ? n.user(c.im_user_id) : n.channel(rows[i]!.conversation_id), type: c?.kind ?? null, is_ext_shared: !!c?.is_ext_shared } }
  })
  return page(out, limit, offset, { query: q || null, order: order === "rank" ? "relevance" : "newest_first" })
}

// ---------- unread ----------

/** Slack's exact unread state: conversations with unreads and followed threads with unread replies. */
export const unread = (repo: Repo, a: Record<string, unknown>) => {
  const limit = clampLimit(a.limit, 50)
  const perItem = Math.min(clampLimit(a.messages_per_item, 3), 20)
  const maxText = clampText(a.max_text, 500)
  const since = parseTime(a.since)
  const until = parseTime(a.until)
  const n = names(repo)
  const self = repo.identity()?.selfUserId ?? ""
  const convs = repo.sql.all<ConvRow>(
    `${CONV_SELECT} WHERE r.has_unreads = 1 AND c.is_member = 1 AND c.is_archived = 0 ${a.include_muted === true ? "" : "AND c.is_muted = 0"}
       ${since ? "AND r.latest >= ?" : ""} ${until ? "AND r.latest <= ?" : ""} ${typeFilter(list(a.type))}
     ORDER BY r.latest DESC LIMIT ?`,
    ...(since ? [since] : []), ...(until ? [until] : []), limit + 1,
  )
  const conversations = convs.slice(0, limit).map((c) => {
    const rows = repo.sql.all<MsgRow>(
      `SELECT ${MSG_COLS} FROM messages m WHERE m.conversation_id = ? AND m.is_reply = 0 AND m.deleted = 0 AND m.ts > coalesce(?, '0')
         AND coalesce(m.user_id, '') != ? ${systemClause} ORDER BY m.ts DESC LIMIT ?`,
      c.id, c.last_read, self, perItem,
    )
    const unreadStored = repo.sql.all<{ n: number }>(
      `SELECT count(*) AS n FROM messages m WHERE m.conversation_id = ? AND m.is_reply = 0 AND m.deleted = 0 AND m.ts > coalesce(?, '0') AND coalesce(m.user_id, '') != ? ${systemClause}`,
      c.id, c.last_read, self)[0]?.n ?? 0
    return { ...convOut(repo, n, c), unread_messages_stored: unreadStored, latest_unread: shape(repo, n, rows, maxText, false) }
  })
  const threads = repo.sql.all<{ conversation_id: string; thread_ts: string; last_read: string | null; unread_count: number | null; source: string | null; latest_reply: string | null; reply_count: number | null }>(
    `SELECT t.conversation_id, t.thread_ts, t.last_read, t.unread_count, t.source, p.latest_reply, p.reply_count
     FROM thread_reads t JOIN conversations c ON c.id = t.conversation_id
     LEFT JOIN messages p ON p.conversation_id = t.conversation_id AND p.ts = t.thread_ts
     WHERE t.subscribed = 1 AND (coalesce(t.unread_count, 0) > 0 OR (p.latest_reply IS NOT NULL AND p.latest_reply > coalesce(t.last_read, '0')))
       ${a.include_muted === true ? "" : "AND c.is_muted = 0"} ${since ? "AND coalesce(p.latest_reply, t.thread_ts) >= ?" : ""} ${until ? "AND coalesce(p.latest_reply, t.thread_ts) <= ?" : ""}
     ORDER BY coalesce(p.latest_reply, t.thread_ts) DESC LIMIT ?`,
    ...(since ? [since] : []), ...(until ? [until] : []), limit + 1,
  ).slice(0, limit).map((t) => {
    const parent = repo.sql.all<MsgRow>(`SELECT ${MSG_COLS} FROM messages m WHERE m.conversation_id = ? AND m.ts = ?`, t.conversation_id, t.thread_ts)
    const replies = repo.sql.all<MsgRow>(
      `SELECT ${MSG_COLS} FROM messages m WHERE m.conversation_id = ? AND m.thread_ts = ? AND m.is_reply = 1 AND m.deleted = 0 AND m.ts > coalesce(?, '0')
         AND coalesce(m.user_id, '') != ? ORDER BY m.ts DESC LIMIT ?`,
      t.conversation_id, t.thread_ts, t.last_read, self, perItem,
    )
    const c = repo.conversation(t.conversation_id)
    return {
      channel: { id: t.conversation_id, name: c?.kind === "im" ? n.user(c.im_user_id) : n.channel(t.conversation_id), type: c?.kind ?? null, is_ext_shared: !!c?.is_ext_shared },
      thread_ts: t.thread_ts,
      permalink: n.permalink(t.conversation_id, t.thread_ts),
      last_read: t.last_read,
      slack_unread_count: t.unread_count,
      reply_count: t.reply_count,
      latest_reply: t.latest_reply,
      parent: shape(repo, n, parent, maxText, false)[0] ?? null,
      latest_unread: shape(repo, n, replies, maxText, false),
    }
  })
  const badges = repo.sql.all("SELECT thread_unreads, thread_mentions, channels, dms, updated_at FROM badges")[0] ?? null
  let out = { badges, conversations, threads, truncated: convs.length > limit }
  while (JSON.stringify(out).length > MAX_BYTES && (out.conversations.length > 1 || out.threads.length > 1)) {
    out = { ...out, truncated: true, conversations: out.conversations.slice(0, Math.ceil(out.conversations.length * 0.75)), threads: out.threads.slice(0, Math.ceil(out.threads.length * 0.75)) }
  }
  return out
}

// ---------- users ----------

export const users = (repo: Repo, a: Record<string, unknown>) => {
  const limit = clampLimit(a.limit, 25)
  const offset = offsetOf(a.cursor)
  const q = typeof a.query === "string" ? a.query.trim().replace(/^@/, "") : ""
  const ids = list(a.ids)
  const where: string[] = ["(u.name IS NOT NULL OR u.real_name IS NOT NULL)"]
  const params: unknown[] = []
  if (ids.length) { where.push(`u.id IN (${ids.map(() => "?").join(",")})`); params.push(...ids) }
  if (q) {
    where.push("(u.id = ? OR u.name LIKE ? OR u.real_name LIKE ? OR u.display_name LIKE ? OR u.email LIKE ?)")
    params.push(q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
  }
  if (a.external === true) where.push("u.is_external = 1")
  if (a.include_bots !== true) where.push("u.is_bot = 0")
  if (a.include_deleted !== true) where.push("u.deleted = 0")
  const rows = repo.sql.all<{ id: string; team_id: string | null; name: string | null; real_name: string | null; display_name: string | null; email: string | null; is_bot: number; is_external: number; deleted: number; tz: string | null; raw: string | null; dm: string | null }>(
    `SELECT u.id, u.team_id, u.name, u.real_name, u.display_name, u.email, u.is_bot, u.is_external, u.deleted, u.tz, u.raw,
       (SELECT id FROM conversations c WHERE c.kind = 'im' AND c.im_user_id = u.id LIMIT 1) AS dm
     FROM users u WHERE ${where.join(" AND ")}
     ORDER BY (u.id = ?) DESC, (lower(u.name) = lower(?) OR lower(u.display_name) = lower(?) OR lower(u.real_name) = lower(?)) DESC, u.real_name
     LIMIT ? OFFSET ?`,
    ...params, q, q, q, q, limit + 1, offset,
  )
  return page(rows.map((u) => {
    const raw = u.raw ? (JSON.parse(u.raw) as { profile?: { title?: string } }) : {}
    return {
      id: u.id, name: u.name, real_name: u.real_name, display_name: u.display_name || null, email: u.email, title: raw.profile?.title || null,
      team_id: u.team_id, is_external: !!u.is_external, is_bot: !!u.is_bot, deleted: !!u.deleted, tz: u.tz, dm_channel: u.dm,
    }
  }), limit, offset)
}

// ---------- sql + schema ----------

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i

export class ReadOnlySqlError extends Error {}

/**
 * Read-only SQL for agents: single SELECT/WITH statement, keyword denylist,
 * executed inside a transaction that is always rolled back.
 */
export const readOnlySql = (repo: Repo, query: string, params: ReadonlyArray<unknown> = [], maxRows = 1000) => {
  const q = query.trim().replace(/;\s*$/, "")
  if (!/^(select|with)\b/i.test(q) || q.includes(";") || FORBIDDEN.test(q.replace(/'[^']*'/g, "''"))) {
    throw new ReadOnlySqlError("only a single SELECT/WITH statement is allowed")
  }
  let rows: unknown[] = []
  const rollback = new Error("rollback")
  try {
    repo.sql.transaction(() => {
      rows = repo.sql.all(`SELECT * FROM (${q}) LIMIT ${maxRows}`, ...params)
      throw rollback
    })
  } catch (e) {
    if (e !== rollback) throw e
  }
  return rows
}

export const sqlTool = (repo: Repo, a: Record<string, unknown>) => {
  if (typeof a.query !== "string") throw new QueryError("query is required")
  const limit = Math.min(Math.max(1, Math.floor(Number(a.limit ?? 200)) || 200), 1000)
  const rows = readOnlySql(repo, a.query, Array.isArray(a.params) ? a.params : [], limit + 1)
  return page(rows, limit, 0, { note: "use LIMIT/OFFSET in SQL to page" })
}

const TABLE_DOCS: Record<string, string> = {
  workspaces: "Slack team(s). domain builds permalinks.",
  users: "Slack users incl. Slack Connect (is_external=1, team_id = their team). raw = full users.info JSON.",
  conversations: "Every conversation. kind: channel|private|im|mpim. im_user_id = the other person for DMs. is_ext_shared = Slack Connect. is_member = the owner is currently in it.",
  conversation_members: "Known members per conversation (filled for DMs/group DMs/Slack Connect).",
  messages: "One row per message or reply. ts/thread_ts are Slack ts strings (fixed width, compare as text). thread_ts = ts for parents, parent ts for replies, NULL for plain messages. is_reply = non-broadcast reply. user_id/bot_id/subtype as Slack sends them. reply_users = JSON array. deleted = tombstone. raw = original Slack JSON.",
  messages_fts: "FTS5 index over messages.text (rowid = messages.id). Use: SELECT ... FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH 'word'.",
  message_edits: "Edit history: previous_text -> text at edited_ts.",
  reactions: "One row per (message, emoji, user).",
  files: "File metadata (no contents) attached to messages.",
  channel_reads: "Slack's read state per conversation: last_read cursor, latest ts, has_unreads, unread_count_display, mention_count (from client.counts and *_marked events).",
  thread_reads: "Slack's read state per thread: subscribed (following), last_read cursor, unread_count (from subscriptions.thread.getView and thread_marked events).",
  badges: "Slack's sidebar badge totals (thread_unreads, thread_mentions, channels, dms).",
  events: "Raw realtime event log (last ~72h). payload = original RTM JSON.",
  sync_state: "Contiguous history range per conversation: every message with oldest_ts <= ts <= newest_ts was fetched. fill_error = last history error.",
  thread_sync: "Thread reply backfill queue. full = 1 once every reply was fetched; newest_ts = replies complete through.",
  meta: "Key/value: self_user_id, team_id, rtm_state, auth_error, ...",
}

export const describeSchema = (repo: Repo) => {
  const tables = repo.sql.all<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'messages_fts_%' AND name NOT IN ('api_samples') ORDER BY name",
  )
  return {
    self_user_id: repo.identity()?.selfUserId ?? null,
    notes: [
      "Slack ts values are TEXT like '1791000000.123456'; compare as strings. Convert: datetime(CAST(ts AS REAL), 'unixepoch').",
      "The owner's own messages: messages.user_id = (SELECT value FROM meta WHERE key = 'self_user_id').",
      "Unread top-level message: ts > channel_reads.last_read. Unread reply: ts > thread_reads.last_read for a subscribed thread.",
      "Mentions of the owner appear in text as '<@SELF_ID>'.",
      "SQL is read-only: one SELECT/WITH, max 1000 rows.",
    ],
    tables: tables.map((t) => ({
      name: t.name,
      description: TABLE_DOCS[t.name] ?? null,
      columns: repo.sql.all<{ name: string; type: string }>(`SELECT name, type FROM pragma_table_info('${t.name.replace(/'/g, "")}')`).map((c) => `${c.name} ${c.type}`.trim()),
    })),
    indexes: repo.sql.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").map((r) => r.sql),
  }
}

// ---------- status ----------

/**
 * Per-conversation coverage of Slack's unread state: complete when the stored history range
 * reaches down to last_read and up to Slack's latest message.
 */
const UNREAD_COVERAGE = `
  SELECT c.id, c.kind, c.name, c.im_user_id, r.last_read, r.latest,
    coalesce(s.oldest_ts, s.newest_ts) AS history_from, s.newest_ts AS history_through, s.fill_error,
    (SELECT min(ts) FROM messages m WHERE m.conversation_id = c.id) AS oldest_stored,
    CASE WHEN coalesce(s.oldest_ts, s.newest_ts) <= r.last_read
      AND (s.newest_ts >= r.latest OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.ts = r.latest)) THEN 1 ELSE 0 END AS complete
  FROM channel_reads r JOIN conversations c ON c.id = r.conversation_id
  LEFT JOIN sync_state s ON s.conversation_id = c.id
  WHERE r.has_unreads = 1`

export const status = (repo: Repo, windows: { channelHours: number; dmHours: number; threadHours: number }, a: Record<string, unknown> = {}) => {
  const meta = (k: string) => repo.getMeta(k) ?? null
  const ms = (v: string | null) => (v ? new Date(Number(v)).toISOString() : null)
  const coverage = repo.sql.all<{ type: string; conversations: number; active_in_window: number; history_filled: number; oldest_ts: string | null; newest_ts: string | null; messages: number }>(
    `WITH conv AS (
       SELECT c.id, CASE WHEN c.is_ext_shared = 1 THEN 'ext_shared' ELSE c.kind END AS type, r.latest,
         CASE WHEN c.kind IN ('im','mpim') OR c.is_ext_shared = 1 THEN ? ELSE ? END AS since
       FROM conversations c LEFT JOIN channel_reads r ON r.conversation_id = c.id WHERE c.is_member = 1)
     SELECT type, count(*) AS conversations,
       sum(CASE WHEN latest >= since THEN 1 ELSE 0 END) AS active_in_window,
       sum(CASE WHEN latest >= since AND (SELECT newest_ts FROM sync_state s WHERE s.conversation_id = conv.id) >= latest THEN 1 ELSE 0 END) AS history_filled,
       (SELECT min(ts) FROM messages m WHERE m.conversation_id IN (SELECT id FROM conv c2 WHERE c2.type = conv.type)) AS oldest_ts,
       (SELECT max(ts) FROM messages m WHERE m.conversation_id IN (SELECT id FROM conv c2 WHERE c2.type = conv.type)) AS newest_ts,
       (SELECT count(*) FROM messages m WHERE m.conversation_id IN (SELECT id FROM conv c2 WHERE c2.type = conv.type)) AS messages
     FROM conv GROUP BY type ORDER BY type`,
    ((Date.now() - windows.dmHours * 3600_000) / 1000).toFixed(6), ((Date.now() - windows.channelHours * 3600_000) / 1000).toFixed(6),
  )
  const lastEvent = repo.sql.all<{ at: number | null }>("SELECT max(received_at) AS at FROM events WHERE source = 'rtm'")[0]?.at ?? null
  const lastMsg = repo.sql.all<{ ts: string | null }>("SELECT max(ts) AS ts FROM messages")[0]?.ts ?? null
  const rtmState = meta("rtm_state")
  const authError = meta("auth_error")
  return {
    healthy: rtmState === "connected" && !authError && lastEvent != null && Date.now() - lastEvent < 10 * 60_000,
    identity: repo.identity() ?? null,
    auth_error: authError,
    realtime: {
      state: rtmState,
      connected_at: ms(meta("rtm_connected_at")),
      last_event_at: lastEvent ? new Date(lastEvent).toISOString() : null,
      last_error: meta("rtm_last_error"),
    },
    last_message: { ts: lastMsg, time: isoOf(lastMsg) },
    reconcile: { last_at: ms(meta("last_reconcile_at")), last: meta("last_reconcile") ? JSON.parse(meta("last_reconcile")!) : null, engine_error: meta("engine_error") },
    windows_hours: { channel: windows.channelHours, private: windows.channelHours, im: windows.dmHours, mpim: windows.dmHours, ext_shared: windows.dmHours, threads: windows.threadHours },
    coverage: coverage.map((c) => ({ ...c, oldest: isoOf(c.oldest_ts), newest: isoOf(c.newest_ts) })),
    unread_coverage: unreadCoverage(repo, a),
    threads: repo.sql.all(
      `SELECT (SELECT count(*) FROM thread_reads WHERE subscribed = 1) AS subscribed,
         (SELECT count(*) FROM thread_sync WHERE done = 0) AS backfill_pending, (SELECT count(*) FROM thread_sync WHERE done = 1) AS backfilled`,
    )[0],
    totals: repo.sql.all(
      `SELECT (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM conversations WHERE is_member = 1) AS conversations,
         (SELECT count(*) FROM users WHERE name IS NOT NULL) AS users, (SELECT count(*) FROM users WHERE is_external = 1) AS external_users,
         (SELECT count(*) FROM events) AS events`,
    )[0],
    badges: repo.sql.all("SELECT thread_unreads, thread_mentions, channels, dms, updated_at FROM badges")[0] ?? null,
  }
}

const unreadCoverage = (repo: Repo, a: Record<string, unknown>) => {
  const n = names(repo)
  type Row = { id: string; kind: string; name: string | null; im_user_id: string | null; last_read: string | null; latest: string | null
    history_from: string | null; history_through: string | null; fill_error: string | null; oldest_stored: string | null; complete: number }
  const rows = repo.sql.all<Row>(`${UNREAD_COVERAGE} ORDER BY complete, r.latest DESC`)
  const threads = repo.sql.all<{ unread: number; complete: number }>(
    `SELECT count(*) AS unread, coalesce(sum(coalesce(s.full, 0)), 0) AS complete FROM thread_reads t
     LEFT JOIN thread_sync s ON s.conversation_id = t.conversation_id AND s.thread_ts = t.thread_ts
     WHERE t.subscribed = 1 AND coalesce(t.unread_count, 0) > 0`,
  )[0]
  const shown = a.coverage_detail === true ? rows : rows.filter((r) => !r.complete).slice(0, 100)
  return {
    conversations: rows.length,
    complete: rows.filter((r) => r.complete).length,
    threads,
    [a.coverage_detail === true ? "per_conversation" : "incomplete"]: shown.map((r) => ({
      id: r.id, name: r.kind === "im" ? (n.user(r.im_user_id) ?? r.im_user_id) : r.name, type: r.kind,
      last_read: r.last_read, latest: r.latest, history_from: r.history_from, history_through: r.history_through,
      oldest_stored: r.oldest_stored, complete: !!r.complete, ...(r.fill_error ? { fill_error: r.fill_error } : {}),
    })),
  }
}
