/**
 * Schema. Slack timestamps ("1700000000.123456") are stored as TEXT; they are
 * fixed-width so lexical comparison equals numeric comparison.
 */
export const MIGRATIONS: ReadonlyArray<string> = [
  /* sql */ `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT,
  domain TEXT,
  enterprise_id TEXT,
  self_user_id TEXT,
  raw TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  name TEXT,
  real_name TEXT,
  display_name TEXT,
  email TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  is_external INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  tz TEXT,
  raw TEXT,
  updated_at INTEGER NOT NULL
);

-- kind: channel | private | im | mpim
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  kind TEXT NOT NULL,
  name TEXT,
  im_user_id TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_member INTEGER NOT NULL DEFAULT 1,
  is_shared INTEGER NOT NULL DEFAULT 0,
  is_ext_shared INTEGER NOT NULL DEFAULT 0,
  is_muted INTEGER NOT NULL DEFAULT 0,
  topic TEXT,
  purpose TEXT,
  created INTEGER,
  raw TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_kind ON conversations(kind);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS conversation_members_user ON conversation_members(user_id);

-- thread_ts: NULL for plain top-level messages, = ts for thread parents,
-- parent ts for replies. is_reply = thread reply that is not broadcast.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  thread_ts TEXT,
  is_reply INTEGER NOT NULL DEFAULT 0,
  is_broadcast INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  bot_id TEXT,
  subtype TEXT,
  text TEXT,
  reply_count INTEGER,
  latest_reply TEXT,
  reply_users TEXT,
  edited_ts TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  mentions_me INTEGER NOT NULL DEFAULT 0,
  raw TEXT,
  inserted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (conversation_id, ts)
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(conversation_id, thread_ts, ts);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id, ts);
CREATE INDEX IF NOT EXISTS messages_mentions ON messages(ts) WHERE mentions_me = 1;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, coalesce(new.text, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, coalesce(old.text, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, coalesce(old.text, ''));
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, coalesce(new.text, ''));
END;

CREATE TABLE IF NOT EXISTS message_edits (
  conversation_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  edited_ts TEXT NOT NULL,
  previous_text TEXT,
  text TEXT,
  PRIMARY KEY (conversation_id, ts, edited_ts)
);

CREATE TABLE IF NOT EXISTS reactions (
  conversation_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, ts, name, user_id)
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  ts TEXT,
  user_id TEXT,
  name TEXT,
  title TEXT,
  mimetype TEXT,
  filetype TEXT,
  size INTEGER,
  permalink TEXT,
  url_private TEXT,
  created INTEGER,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS files_message ON files(conversation_id, ts);

-- Channel/DM read state exactly as Slack reports it (client.counts,
-- conversations.info, *_marked events). last_read is authoritative.
CREATE TABLE IF NOT EXISTS channel_reads (
  conversation_id TEXT PRIMARY KEY,
  last_read TEXT,
  latest TEXT,
  has_unreads INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER,
  unread_count_display INTEGER,
  mention_count INTEGER,
  source TEXT,
  updated_at INTEGER NOT NULL
);

-- Per-thread read state (thread_marked / thread_subscribed events,
-- subscriptions.thread.getView, parent message last_read/subscribed).
CREATE TABLE IF NOT EXISTS thread_reads (
  conversation_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  subscribed INTEGER NOT NULL DEFAULT 0,
  last_read TEXT,
  unread_count INTEGER,
  source TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, thread_ts)
);
CREATE INDEX IF NOT EXISTS thread_reads_subscribed ON thread_reads(subscribed) WHERE subscribed = 1;

-- Global badge counts from client.counts.
CREATE TABLE IF NOT EXISTS badges (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  thread_unreads INTEGER,
  thread_mentions INTEGER,
  channels INTEGER,
  dms INTEGER,
  raw TEXT,
  updated_at INTEGER NOT NULL
);

-- Append-only log of every realtime event and reconciliation snapshot.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  subtype TEXT,
  conversation_id TEXT,
  ts TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_received ON events(received_at);
CREATE INDEX IF NOT EXISTS events_type ON events(type, received_at);

-- Backfill / gap-fill progress per conversation.
CREATE TABLE IF NOT EXISTS sync_state (
  conversation_id TEXT PRIMARY KEY,
  newest_ts TEXT,
  oldest_ts TEXT,
  history_cursor TEXT,
  history_done INTEGER NOT NULL DEFAULT 0,
  members_done INTEGER NOT NULL DEFAULT 0,
  priority TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_sync (
  conversation_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  newest_ts TEXT,
  cursor TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  wanted_latest TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, thread_ts)
);
CREATE INDEX IF NOT EXISTS thread_sync_pending ON thread_sync(done, updated_at);

-- Triage: debounced work items keyed by conversation + thread (or message).
CREATE TABLE IF NOT EXISTS triage_queue (
  item_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  thread_ts TEXT,
  latest_ts TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS triage_queue_due ON triage_queue(due_at);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  item_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  thread_ts TEXT,
  latest_ts TEXT NOT NULL,
  probability REAL NOT NULL,
  importance TEXT NOT NULL,
  reason TEXT,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_item ON decisions(item_key, created_at);

-- Notifier outbox. One open (pending|delivered) row per item_key.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  item_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  thread_ts TEXT,
  latest_ts TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 1,
  probability REAL NOT NULL,
  importance TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER,
  needs_delivery INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_open ON notifications(item_key) WHERE status IN ('pending', 'delivered');
CREATE INDEX IF NOT EXISTS notifications_status ON notifications(status, updated_at);

CREATE TABLE IF NOT EXISTS api_samples (
  method TEXT PRIMARY KEY,
  captured_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
`,
  // v2: dumb mirror. Drop triage/notifier state and derived fields.
  /* sql */ `
DROP TABLE IF EXISTS triage_queue;
DROP TABLE IF EXISTS decisions;
DROP TABLE IF EXISTS notifications;
DROP INDEX IF EXISTS messages_mentions;
ALTER TABLE messages DROP COLUMN mentions_me;
`,
  // v3: unread-complete coverage. sync_state.oldest_ts is now the bottom of the contiguous history range.
  /* sql */ `
ALTER TABLE sync_state ADD COLUMN fill_error TEXT;
ALTER TABLE sync_state ADD COLUMN fill_error_at INTEGER;
ALTER TABLE thread_sync ADD COLUMN full INTEGER NOT NULL DEFAULT 0;
`,
]

import type { Sql } from "./sql.ts"

export const migrate = (sql: Sql): void => {
  sql.script("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
  const done = new Set(sql.all<{ version: number }>("SELECT version FROM _migrations").map((r) => r.version))
  MIGRATIONS.forEach((m, i) => {
    if (done.has(i)) return
    sql.transaction(() => {
      sql.script(m)
      sql.run("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)", i, Date.now())
    })
  })
}
