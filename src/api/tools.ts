import { Effect } from "effect"
import type { Repo } from "../store/store.ts"
import * as Q from "./queries.ts"

/** Side-effecting operations the Durable Object provides to the API layer. */
export interface ApiActions {
  readonly markRead: (p: { channel: string; ts: string; threadTs?: string | undefined }) => Effect.Effect<unknown, { readonly _tag: string; readonly message?: string }>
  readonly setSession: (p: { token: string; cookie: string }) => Effect.Effect<unknown, { readonly _tag: string; readonly message?: string }>
  readonly reconcileNow: () => Effect.Effect<unknown>
  readonly windows: { channelHours: number; dmHours: number; threadHours: number }
}

export class ToolError extends Error {}

type Args = Record<string, unknown>
type Schema = Record<string, unknown>

const str = (description: string, extra: Schema = {}) => ({ type: "string", description, ...extra })
const int = (description: string) => ({ type: "integer", description, minimum: 1 })
const bool = (description: string) => ({ type: "boolean", description })
const TIME = "Slack ts, unix seconds, ISO 8601, or relative age like 30m/48h/14d"
const COMMON = {
  limit: int(`Max items (default varies, max ${Q.MAX_LIMIT}). Responses are also capped at ~${Q.MAX_BYTES / 1000}KB; follow next_cursor.`),
  cursor: str("next_cursor from a previous response"),
  since: str(`Lower time bound. ${TIME}`),
  until: str(`Upper time bound. ${TIME}`),
}
const TYPE = {
  type: {
    description: "Conversation type filter; one value, array or comma list: channel | private | im | mpim | shared | ext_shared (Slack Connect)",
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string", enum: ["channel", "private", "im", "mpim", "shared", "ext_shared"] } }],
  },
}
const CHANNEL = str("Conversation id (C…/G…/D…), channel name (with or without #), or a DM partner's name/email")

export interface Tool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Schema
  readonly readOnly: boolean
  readonly run: (repo: Repo, actions: ApiActions, a: Args) => Effect.Effect<unknown, Error>
}

const sync = (f: (repo: Repo, a: Args, actions: ApiActions) => unknown): Tool["run"] =>
  (repo, actions, a) => Effect.try({ try: () => f(repo, a, actions), catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

const obj = (properties: Schema, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false })

const SLACK_TS = /^\d{10}\.\d{6}$/

export const TOOLS: ReadonlyArray<Tool> = [
  {
    name: "status",
    title: "Mirror status",
    description: "Sync health: realtime websocket state, last event time, auth_error (non-null = Slack session expired, data is stale), history window and coverage per conversation type, unread_coverage (whether every unread message of each unread conversation, and every reply of each unread thread, is stored), thread backfill progress, Slack badge totals. Call first.",
    inputSchema: obj({ coverage_detail: { type: "boolean", description: "List coverage for every unread conversation (default: only incomplete ones)." } }),
    readOnly: true,
    run: sync((repo, a, actions) => Q.status(repo, actions.windows, a)),
  },
  {
    name: "list_conversations",
    title: "List conversations",
    description: "Conversations the owner is in, most recently active first: type, Slack Connect flags, members, Slack read state (last_read, has_unreads, unread_count_display, mention_count), last activity and my_last_post_ts (the owner's latest stored message).",
    inputSchema: obj({
      ...TYPE,
      unread: bool("Only conversations Slack shows as unread"),
      query: str("Substring of channel name or DM partner name/email"),
      active_since: str(`Only conversations active since. ${TIME}`),
      include_muted: bool("Include muted conversations (default true)"),
      include_archived: bool("Include archived (default false)"),
      include_non_member: bool("Include conversations the owner is not a member of (default false)"),
      ...COMMON,
    }),
    readOnly: true,
    run: sync((repo, a) => Q.listConversations(repo, a)),
  },
  {
    name: "unread",
    title: "Unread items",
    description: "Exactly what Slack shows as unread: conversations with unreads (with their newest unread messages) and followed threads with unread replies (with the parent and newest unread replies). Muted conversations excluded unless include_muted.",
    inputSchema: obj({
      ...TYPE,
      include_muted: bool("Include muted conversations (default false)"),
      messages_per_item: int("Unread messages to include per conversation/thread (default 3, max 20)"),
      max_text: int("Truncate message text to this many chars (default 500)"),
      limit: COMMON.limit, since: str(`Only items with activity since. ${TIME}`), until: COMMON.until,
    }),
    readOnly: true,
    run: sync((repo, a) => Q.unread(repo, a)),
  },
  {
    name: "get_conversation",
    title: "Get conversation messages",
    description: "Messages in one conversation, newest first, with conversation header and read state. Top-level messages only by default (each with reply_count/latest_reply/reply_users; use get_thread for replies). Full text, reactions, file metadata, permalinks.",
    inputSchema: obj({
      channel: CHANNEL,
      include_replies: bool("Also include thread replies inline (default false)"),
      include_bots: bool("Include bot messages (default true here)"),
      include_system: bool("Include join/leave/topic messages (default false)"),
      max_text: int("Truncate text to this many chars (default 4000)"),
      ...COMMON,
    }, ["channel"]),
    readOnly: true,
    run: sync((repo, a) => Q.getConversation(repo, a)),
  },
  {
    name: "get_thread",
    title: "Get thread",
    description: "A thread's parent and all stored replies, oldest first, with Slack's per-thread read state (subscribed, last_read, unread_count). Full text, reactions, file metadata, permalinks.",
    inputSchema: obj({
      channel: CHANNEL,
      ts: str("Thread parent ts (thread_ts)"),
      max_text: int("Truncate text to this many chars (default 4000)"),
      limit: COMMON.limit, cursor: COMMON.cursor,
    }, ["channel", "ts"]),
    readOnly: true,
    run: sync((repo, a) => Q.getThread(repo, a)),
  },
  {
    name: "search",
    title: "Search messages",
    description: "Full-text search (SQLite FTS5; plain words are AND-ed, quotes/OR/NOT/prefix* allowed) across all mirrored messages and replies, newest first. query may be empty to filter only. Bots excluded unless include_bots.",
    inputSchema: obj({
      query: str("Search text (optional)"),
      channel: CHANNEL,
      from: str("Sender: user id, handle, display/real name or email"),
      mentions_me: bool("Only messages that @-mention the owner, plus all DM messages"),
      mentions: str("Only messages that @-mention this user (id/name/email)"),
      ...TYPE,
      include_bots: bool("Include bot messages (default false)"),
      sort: str("newest (default) or relevance", { enum: ["newest", "relevance"] }),
      max_text: int("Truncate text to this many chars (default 1000)"),
      ...COMMON,
    }),
    readOnly: true,
    run: sync((repo, a) => Q.search(repo, a)),
  },
  {
    name: "users",
    title: "Look up users",
    description: "Find users by id, handle, name or email (substring), including external Slack Connect users (is_external, team_id). Returns their DM channel id when one exists.",
    inputSchema: obj({
      query: str("id, handle, name or email substring"),
      ids: { type: "array", items: { type: "string" }, description: "Exact user ids" },
      external: bool("Only external (Slack Connect) users"),
      include_bots: bool("Include bots (default false)"),
      include_deleted: bool("Include deactivated users (default false)"),
      limit: COMMON.limit, cursor: COMMON.cursor,
    }),
    readOnly: true,
    run: sync((repo, a) => Q.users(repo, a)),
  },
  {
    name: "describe_schema",
    title: "Describe SQL schema",
    description: "Tables, columns, indexes and conventions of the mirror's SQLite database, for use with sql.",
    inputSchema: obj({}),
    readOnly: true,
    run: sync((repo) => Q.describeSchema(repo)),
  },
  {
    name: "sql",
    title: "Read-only SQL",
    description: "Run one read-only SQLite SELECT/WITH statement over the mirror (see describe_schema). Max 1000 rows; bind values with ? and params.",
    inputSchema: obj({
      query: str("SELECT/WITH statement"),
      params: { type: "array", items: {}, description: "Positional bind values" },
      limit: int("Max rows (default 200, max 1000)"),
    }, ["query"]),
    readOnly: true,
    run: sync((repo, a) => Q.sqlTool(repo, a)),
  },
  {
    name: "mark_read",
    title: "Mark read in Slack",
    description: "WRITES TO SLACK: moves the owner's own read cursor in Slack (conversations.mark, or subscriptions.thread.mark with thread_ts) up to ts, exactly like opening it in a Slack client. Only use when asked to mark something read. Returns the mirror's updated read state.",
    inputSchema: obj({
      channel: CHANNEL,
      ts: str("Mark read up to and including this message ts"),
      thread_ts: str("Thread parent ts, to mark a thread read instead of the conversation"),
    }, ["channel", "ts"]),
    readOnly: false,
    run: (repo, actions, a) =>
      Effect.gen(function* () {
        const channel = yield* Effect.try({ try: () => Q.resolveConversation(repo, a.channel), catch: (e) => e as Error })
        const ts = String(a.ts ?? "")
        const threadTs = a.thread_ts == null || a.thread_ts === "" ? undefined : String(a.thread_ts)
        if (!SLACK_TS.test(ts) || (threadTs && !SLACK_TS.test(threadTs))) return yield* Effect.fail(new ToolError("ts/thread_ts must be Slack ts like 1791000000.123456"))
        yield* actions.markRead({ channel, ts, threadTs }).pipe(Effect.mapError((e) => new ToolError(`${e._tag}${e.message ? `: ${e.message}` : ""}`)))
        return {
          ok: true, channel, ts, thread_ts: threadTs ?? null,
          read_state: threadTs ? repo.threadRead(channel, threadTs) ?? null : repo.channelRead(channel) ?? null,
        }
      }),
  },
]

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name)

export const INSTRUCTIONS = `slack-mirror: a realtime, read-state-exact mirror of one person's Slack ("the owner", whose session it runs as), including DMs, group DMs and Slack Connect. It is a plain database of Slack data: messages, threads, reactions, file metadata, users, conversations and the owner's read/unread state as Slack shows it. It does no ranking or judgment; you do that.

Coverage: realtime for everything; every unread conversation back to its last_read and every unread thread in full (no time cap); everything else ~48h of history. status.unread_coverage says what is complete; each conversation's history.from/through is its stored range.

Recommended workflow:
1. status: check healthy/auth_error and coverage before trusting results.
2. unread and/or list_conversations (e.g. type=im,mpim,ext_shared active_since=48h) and search (mentions_me=true since=7d) to find candidates. Each item carries raw facts: read state, latest ts, my_last_post_ts, reply_count/latest_reply/reply_users, user names.
3. get_thread / get_conversation to read full context before concluding.
4. sql (after describe_schema) for anything the tools don't cover, e.g. "threads where someone replied after the owner's last reply".
The owner's Slack user id is in status.identity.selfUserId; their mentions appear in text as <@ID|name>. ts values are Slack timestamps; permalinks open in Slack. Lists are paged: pass next_cursor back as cursor.
mark_read is the only tool that changes Slack; use it only when explicitly asked.`
