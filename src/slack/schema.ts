import { Schema as S } from "effect"

const Str = S.String
const OptStr = S.optional(S.NullOr(S.String))
const OptNum = S.optional(S.NullOr(S.Number))
const OptBool = S.optional(S.NullOr(S.Boolean))

export const Reaction = S.Struct({
  name: Str,
  users: S.optional(S.Array(Str)),
  count: OptNum,
})

export const File = S.Struct({
  id: Str,
  name: OptStr,
  title: OptStr,
  mimetype: OptStr,
  filetype: OptStr,
  size: OptNum,
  permalink: OptStr,
  url_private: OptStr,
  user: OptStr,
  created: OptNum,
})
export type File = typeof File.Type

/** A Slack message as returned by history/replies/RTM. Unknown keys are kept in `raw`. */
export const Message = S.Struct({
  type: S.optional(Str),
  ts: Str,
  thread_ts: OptStr,
  user: OptStr,
  bot_id: OptStr,
  subtype: OptStr,
  text: OptStr,
  hidden: OptBool,
  reply_count: OptNum,
  latest_reply: OptStr,
  reply_users: S.optional(S.Array(Str)),
  subscribed: OptBool,
  last_read: OptStr,
  edited: S.optional(S.Struct({ user: OptStr, ts: Str })),
  reactions: S.optional(S.Array(Reaction)),
  files: S.optional(S.Array(File)),
  blocks: S.optional(S.Unknown),
  attachments: S.optional(S.Unknown),
})
export type Message = typeof Message.Type

export const Topic = S.Struct({ value: OptStr })

export const Conversation = S.Struct({
  id: Str,
  name: OptStr,
  user: OptStr,
  is_channel: OptBool,
  is_group: OptBool,
  is_im: OptBool,
  is_mpim: OptBool,
  is_private: OptBool,
  is_archived: OptBool,
  is_member: OptBool,
  is_shared: OptBool,
  is_ext_shared: OptBool,
  is_org_shared: OptBool,
  context_team_id: OptStr,
  created: OptNum,
  topic: S.optional(S.NullOr(Topic)),
  purpose: S.optional(S.NullOr(Topic)),
  last_read: OptStr,
  latest: S.optional(S.Unknown),
  unread_count: OptNum,
  unread_count_display: OptNum,
})
export type Conversation = typeof Conversation.Type

export const User = S.Struct({
  id: Str,
  team_id: OptStr,
  name: OptStr,
  real_name: OptStr,
  deleted: OptBool,
  is_bot: OptBool,
  tz: OptStr,
  is_stranger: OptBool,
  profile: S.optional(
    S.Struct({
      display_name: OptStr,
      real_name: OptStr,
      email: OptStr,
    }),
  ),
})
export type User = typeof User.Type

export const ThreadSubscription = S.Struct({
  type: Str,
  channel: S.optional(Str),
  thread_ts: S.optional(Str),
  date_create: OptNum,
  active: OptBool,
  last_read: OptStr,
})

/* ---------------- API responses ---------------- */

export const AuthTest = S.Struct({
  ok: S.Literal(true),
  url: Str,
  team: Str,
  user: Str,
  team_id: Str,
  user_id: Str,
  enterprise_id: OptStr,
})
export type AuthTest = typeof AuthTest.Type

export const CountsEntry = S.Struct({
  id: Str,
  last_read: OptStr,
  latest: OptStr,
  updated: OptStr,
  mention_count: OptNum,
  has_unreads: OptBool,
})
export type CountsEntry = typeof CountsEntry.Type

export const ClientCounts = S.Struct({
  ok: S.Literal(true),
  threads: S.optional(S.Struct({ has_unreads: OptBool, mention_count: OptNum, unread_count: OptNum })),
  channels: S.Array(CountsEntry),
  mpims: S.Array(CountsEntry),
  ims: S.Array(CountsEntry),
  channel_badges: S.optional(
    S.Struct({ channels: OptNum, dms: OptNum, app_dms: OptNum, thread_mentions: OptNum, thread_unreads: OptNum }),
  ),
})
export type ClientCounts = typeof ClientCounts.Type

export const UserBoot = S.Struct({
  ok: S.Literal(true),
  self: S.Struct({ id: Str, name: OptStr }),
  team: S.Struct({ id: Str, name: OptStr, domain: OptStr, enterprise_id: OptStr }),
  ims: S.optional(S.Array(Conversation)),
  channels: S.optional(S.Array(Conversation)),
  is_open: S.optional(S.Array(Str)),
  subteams: S.optional(S.Struct({ self: S.optional(S.Array(Str)) })),
  prefs: S.optional(S.Struct({ all_notifications_prefs: OptStr, muted_channels: OptStr })),
})
export type UserBoot = typeof UserBoot.Type

const ResponseMetadata = S.optional(S.Struct({ next_cursor: OptStr }))

export const ConversationsPage = S.Struct({
  ok: S.Literal(true),
  channels: S.Array(Conversation),
  response_metadata: ResponseMetadata,
})

export const ConversationInfo = S.Struct({ ok: S.Literal(true), channel: Conversation })

export const UsersPage = S.Struct({
  ok: S.Literal(true),
  members: S.Array(User),
  response_metadata: ResponseMetadata,
})

export const UserInfo = S.Struct({ ok: S.Literal(true), user: User })

export const MembersPage = S.Struct({
  ok: S.Literal(true),
  members: S.Array(Str),
  response_metadata: ResponseMetadata,
})

export const HistoryPage = S.Struct({
  ok: S.Literal(true),
  messages: S.Array(Message),
  has_more: OptBool,
  response_metadata: ResponseMetadata,
})
export type HistoryPage = typeof HistoryPage.Type

export const ThreadView = S.Struct({
  ok: S.Literal(true),
  total_unread_replies: OptNum,
  new_threads_count: OptNum,
  has_more: OptBool,
  threads: S.Array(
    S.Struct({
      root_msg: S.extend(Message, S.Struct({ channel: S.optional(Str) })),
      unread_replies: S.optional(S.Array(Message)),
      latest_replies: S.optional(S.Array(Message)),
    }),
  ),
})
export type ThreadView = typeof ThreadView.Type

export const RtmConnect = S.Struct({
  ok: S.Literal(true),
  url: Str,
  self: S.optional(S.Struct({ id: Str })),
  team: S.optional(S.Struct({ id: Str, domain: OptStr })),
})

/* ---------------- RTM events ---------------- */

export const MessageEvent = S.Struct({
  ...Message.fields,
  type: S.Literal("message"),
  channel: Str,
  event_ts: OptStr,
  message: S.optional(Message),
  previous_message: S.optional(Message),
  deleted_ts: OptStr,
})
export type MessageEvent = typeof MessageEvent.Type

export const ReactionEvent = S.Struct({
  type: S.Literal("reaction_added", "reaction_removed"),
  user: Str,
  reaction: Str,
  item: S.Struct({ type: Str, channel: S.optional(Str), ts: S.optional(Str) }),
  event_ts: OptStr,
})

export const MarkedEvent = S.Struct({
  type: S.Literal("channel_marked", "group_marked", "mpim_marked", "im_marked"),
  channel: Str,
  ts: Str,
  unread_count: OptNum,
  unread_count_display: OptNum,
  mention_count: OptNum,
  mention_count_display: OptNum,
  num_mentions_display: OptNum,
  dm_count: OptNum,
  event_ts: OptStr,
})
export type MarkedEvent = typeof MarkedEvent.Type

export const ThreadEvent = S.Struct({
  type: S.Literal("thread_marked", "thread_subscribed", "thread_unsubscribed"),
  subscription: ThreadSubscription,
  event_ts: OptStr,
})
export type ThreadEvent = typeof ThreadEvent.Type

export const ChannelJoinedEvent = S.Struct({
  type: S.Literal("channel_joined", "group_joined", "channel_created"),
  channel: Conversation,
})

export const ChannelLeftEvent = S.Struct({
  type: S.Literal("channel_left", "group_left", "channel_deleted", "group_deleted"),
  channel: Str,
})

export const ChannelArchiveEvent = S.Struct({
  type: S.Literal("channel_archive", "channel_unarchive", "group_archive", "group_unarchive"),
  channel: Str,
})

export const ChannelRenameEvent = S.Struct({
  type: S.Literal("channel_rename", "group_rename"),
  channel: S.Struct({ id: Str, name: Str }),
})

export const ImOpenEvent = S.Struct({
  type: S.Literal("im_open", "im_created", "mpim_open", "group_open"),
  channel: S.Union(Str, Conversation),
  user: OptStr,
})

export const MemberEvent = S.Struct({
  type: S.Literal("member_joined_channel", "member_left_channel"),
  user: Str,
  channel: Str,
})

export const UserChangeEvent = S.Struct({
  type: S.Literal("user_change", "team_join"),
  user: User,
})

export const FileEvent = S.Struct({
  type: S.Literal("file_deleted"),
  file_id: Str,
})

export const PrefChangeEvent = S.Struct({
  type: S.Literal("pref_change"),
  name: Str,
  value: S.Unknown,
})

export const ControlEvent = S.Struct({
  type: S.Literal("hello", "goodbye", "pong", "reconnect_url", "error"),
  url: OptStr,
  error: S.optional(S.Unknown),
})

export const RtmEvent = S.Union(
  MessageEvent,
  ReactionEvent,
  MarkedEvent,
  ThreadEvent,
  ChannelJoinedEvent,
  ChannelLeftEvent,
  ChannelArchiveEvent,
  ChannelRenameEvent,
  ImOpenEvent,
  MemberEvent,
  UserChangeEvent,
  FileEvent,
  PrefChangeEvent,
  ControlEvent,
)
export type RtmEvent = typeof RtmEvent.Type
