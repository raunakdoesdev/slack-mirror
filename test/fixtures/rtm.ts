// Shapes copied from live RTM traffic (ids/text replaced).
export const SELF = "U0SELF"
export const C = "C0GENERAL"
export const D = "D0DM"

export const hello = { type: "hello", fast_reconnect: false, region: "us-west-2", start: true, host_id: "gatewayserver-pdx-1" }
export const message = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "message", channel: C, user: "U0ALICE", text, ts, event_ts: ts, team: "T0", client_msg_id: "x", ...extra,
})
export const reply = (ts: string, threadTs: string, text: string, user = "U0ALICE") =>
  ({ ...message(ts, text, { thread_ts: threadTs, parent_user_id: SELF }), user })
export const botMessage = (ts: string) => ({
  type: "message", subtype: "bot_message", channel: C, text: "deploy ok", bot_id: "B0", ts, event_ts: ts, suppress_notification: false,
})
export const changed = (ts: string, text: string) => ({
  type: "message", subtype: "message_changed", hidden: true, channel: C, ts: "1791000099.000100", event_ts: "1791000099.000100",
  message: { type: "message", user: "U0ALICE", text, ts, edited: { user: "U0ALICE", ts: "1791000099.000000" } },
  previous_message: { type: "message", user: "U0ALICE", text: "old", ts },
})
export const deleted = (ts: string) => ({
  type: "message", subtype: "message_deleted", hidden: true, channel: C, deleted_ts: ts, ts: "1791000199.000100",
  previous_message: { type: "message", user: "U0ALICE", text: "x", ts },
})
export const replied = (threadTs: string, latest: string) => ({
  type: "message", subtype: "message_replied", hidden: true, channel: C, ts: "1791000299.000100", event_ts: "1791000299.000100",
  message: { type: "message", user: SELF, text: "parent", ts: threadTs, thread_ts: threadTs, reply_count: 2, latest_reply: latest,
    reply_users: ["U0ALICE"], subscribed: true, last_read: threadTs },
})
export const channelMarked = (ts: string, unread = 0, mentions = 0) => ({
  type: "channel_marked", channel: C, ts, unread_count: unread, unread_count_display: unread,
  num_mentions: mentions, num_mentions_display: mentions, mention_count: mentions, mention_count_display: mentions, event_ts: "1791000400.000100",
})
export const imMarked = (ts: string) => ({ type: "im_marked", channel: D, ts, dm_count: 0, unread_count_display: 0, num_mentions_display: 0, mention_count_display: 0, event_ts: "1" })
export const threadMarked = (threadTs: string, lastRead: string) => ({
  type: "thread_marked",
  subscription: { type: "thread", channel: C, thread_ts: threadTs, date_create: 1791000000, active: true, last_read: lastRead },
  event_ts: "1791000500.000100",
})
export const threadSubscribed = (threadTs: string) => ({
  type: "thread_subscribed",
  subscription: { type: "thread", channel: C, thread_ts: threadTs, date_create: 1791000000, active: true, last_read: threadTs },
  event_ts: "1",
})
export const reactionAdded = (ts: string, name = "eyes") => ({
  type: "reaction_added", user: "U0BOB", item: { type: "message", channel: C, ts }, reaction: name, item_user: SELF, event_ts: "1", ts: "1",
})
