import { Effect, Either, Schema } from "effect"
import * as S from "../slack/schema.ts"
import type { Repo } from "../store/store.ts"

/** Side effects the reducer asks the caller to perform (fetches). */
export interface Reduced {
  readonly newMessages: Array<{ conversationId: string; ts: string; threadTs: string | null }>
  readonly readMoved: Array<{ conversationId: string; threadTs: string | null; lastRead: string }>
  /** Conversations whose metadata we don't know yet and should fetch. */
  readonly unknownConversations: Array<string>
  readonly unknownUsers: Array<string>
  readonly control?: S.RtmEvent & { type: "hello" | "goodbye" | "pong" | "reconnect_url" | "error" }
  readonly prefChanged?: string
}

const empty = (): Reduced => ({ newMessages: [], readMoved: [], unknownConversations: [], unknownUsers: [] })

const decode = Schema.decodeUnknownEither(S.RtmEvent)

const noteMessage = (repo: Repo, out: Reduced, channel: string, m: S.Message) => {
  if (!repo.conversation(channel)?.name && !channel.startsWith("D")) out.unknownConversations.push(channel)
  if (m.user && !repo.user(m.user)?.name) out.unknownUsers.push(m.user)
  if (repo.upsertMessage(channel, m)) out.newMessages.push({ conversationId: channel, ts: m.ts, threadTs: m.thread_ts ?? null })
}

/** Applies one realtime event to the store. Pure SQL, synchronous, idempotent. */
export const reduceEvent = (repo: Repo, raw: unknown, source = "rtm"): Reduced => {
  const out = empty()
  const r = raw as { type?: unknown; subtype?: unknown; channel?: unknown; ts?: unknown }
  const decoded = decode(raw)
  if (r.type !== "pong" && r.type !== "reconnect_url" && r.type !== "presence_change") repo.logEvent(source, r, raw)
  if (Either.isLeft(decoded)) return out
  const e = decoded.right
  repo.sql.transaction(() => {
    switch (e.type) {
      case "message": {
        if (e.subtype === "message_changed" && e.message) {
          noteMessage(repo, out, e.channel, e.message)
        } else if (e.subtype === "message_deleted") {
          const ts = e.deleted_ts ?? e.previous_message?.ts
          if (ts) repo.markDeleted(e.channel, ts)
        } else if (e.subtype === "message_replied" && e.message) {
          // Parent update carrying reply_count/latest_reply and, for us, subscribed/last_read.
          noteMessage(repo, out, e.channel, e.message)
        } else {
          noteMessage(repo, out, e.channel, e)
        }
        break
      }
      case "reaction_added":
      case "reaction_removed": {
        const { channel, ts } = e.item
        if (!channel || !ts) break
        repo.ensureConversation(channel)
        if (e.type === "reaction_added") repo.addReaction(channel, ts, e.reaction, e.user)
        else repo.removeReaction(channel, ts, e.reaction, e.user)
        break
      }
      case "channel_marked":
      case "group_marked":
      case "mpim_marked":
      case "im_marked": {
        repo.ensureConversation(e.channel)
        const unread = e.unread_count_display ?? e.unread_count
        const moved = repo.patchChannelRead(e.channel, {
          last_read: e.ts,
          unread_count: e.unread_count,
          unread_count_display: e.unread_count_display,
          mention_count: e.mention_count_display ?? e.mention_count,
          has_unreads: unread == null ? undefined : unread > 0,
        }, e.type)
        if (moved) out.readMoved.push({ conversationId: e.channel, threadTs: null, lastRead: e.ts })
        break
      }
      case "thread_marked":
      case "thread_subscribed":
      case "thread_unsubscribed": {
        const s = e.subscription
        if (!s.channel || !s.thread_ts) break
        repo.ensureConversation(s.channel)
        const moved = repo.patchThreadRead(s.channel, s.thread_ts, {
          subscribed: e.type === "thread_unsubscribed" ? false : (s.active ?? true),
          last_read: s.last_read,
          ...(e.type === "thread_marked" ? { unread_count: 0 } : {}),
        }, e.type)
        if (moved && s.last_read) out.readMoved.push({ conversationId: s.channel, threadTs: s.thread_ts, lastRead: s.last_read })
        break
      }
      case "channel_joined":
      case "group_joined":
      case "channel_created":
        repo.upsertConversation(e.channel, { member: e.type !== "channel_created" ? true : (e.channel.is_member ?? false) })
        if (e.type !== "channel_created") out.unknownConversations.push(e.channel.id)
        break
      case "channel_left":
      case "group_left":
      case "channel_deleted":
      case "group_deleted":
        repo.setConversationField(e.channel, "is_member", false)
        break
      case "channel_archive":
      case "group_archive":
        repo.setConversationField(e.channel, "is_archived", true)
        break
      case "channel_unarchive":
      case "group_unarchive":
        repo.setConversationField(e.channel, "is_archived", false)
        break
      case "channel_rename":
      case "group_rename":
        repo.setConversationField(e.channel.id, "name", e.channel.name)
        break
      case "im_open":
      case "im_created":
      case "mpim_open":
      case "group_open":
        if (typeof e.channel === "string") {
          repo.ensureConversation(e.channel)
          out.unknownConversations.push(e.channel)
        } else repo.upsertConversation(e.channel)
        break
      case "member_joined_channel":
        repo.ensureConversation(e.channel)
        repo.setMembers(e.channel, [e.user], false)
        break
      case "member_left_channel":
        repo.removeMember(e.channel, e.user)
        break
      case "user_change":
      case "team_join":
        repo.upsertUser(e.user)
        break
      case "file_deleted":
        repo.deleteFile(e.file_id)
        break
      case "pref_change":
        ;(out as { prefChanged?: string }).prefChanged = e.name
        break
      case "hello":
      case "goodbye":
      case "pong":
      case "reconnect_url":
      case "error":
        ;(out as { control?: typeof e }).control = e
        break
    }
  })
  return out
}

export const reduce = (repo: Repo, raw: unknown, source?: string) => Effect.sync(() => reduceEvent(repo, raw, source))
