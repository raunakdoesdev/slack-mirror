import { describe, expect, test } from "bun:test"
import { reduceEvent } from "../src/ingest/reduce.ts"
import { migrate } from "../src/store/migrations.ts"
import { makeRepo } from "../src/store/store.ts"
import { bunSql } from "../scripts/bun-sql.ts"
import * as F from "./fixtures/rtm.ts"

const setup = () => {
  const sql = bunSql()
  migrate(sql)
  const repo = makeRepo(sql)
  repo.setIdentity({ selfUserId: F.SELF, teamId: "T0", groupIds: ["S0ENG"] }, { name: "Acme" })
  repo.upsertConversation({ id: F.C, name: "general", is_channel: true })
  return repo
}

describe("reduceEvent", () => {
  test("new message, idempotent replay", () => {
    const repo = setup()
    const r1 = reduceEvent(repo, F.message("1791000001.000100", `hey <@${F.SELF}>`))
    expect(r1.newMessages).toEqual([{ conversationId: F.C, ts: "1791000001.000100", threadTs: null }])
    expect(reduceEvent(repo, F.message("1791000001.000100", `hey <@${F.SELF}>`)).newMessages).toEqual([])
    reduceEvent(repo, F.message("1791000002.000100", "ping <!subteam^S0ENG>"))
    reduceEvent(repo, F.botMessage("1791000003.000100"))
    expect(repo.message(F.C, "1791000003.000100")?.bot_id).toBe("B0")
    expect(repo.sql.all("SELECT * FROM events").length).toBe(4)
  })

  test("edits keep history, deletes tombstone, FTS follows text", () => {
    const repo = setup()
    reduceEvent(repo, F.message("1791000001.000100", "the original words"))
    reduceEvent(repo, F.changed("1791000001.000100", "the corrected words"))
    expect(repo.message(F.C, "1791000001.000100")?.text).toBe("the corrected words")
    expect(repo.sql.all("SELECT previous_text FROM message_edits")).toEqual([{ previous_text: "the original words" }])
    expect(repo.sql.all("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'corrected'").length).toBe(1)
    expect(repo.sql.all("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'original'").length).toBe(0)
    reduceEvent(repo, F.deleted("1791000001.000100"))
    expect(repo.message(F.C, "1791000001.000100")?.deleted).toBe(1)
  })

  test("channel_marked moves last_read and reports it", () => {
    const repo = setup()
    reduceEvent(repo, F.message("1791000001.000100", "a"))
    expect(repo.isRead(F.C, "1791000001.000100", null)).toBe(false)
    const r = reduceEvent(repo, F.channelMarked("1791000001.000100"))
    expect(r.readMoved).toEqual([{ conversationId: F.C, threadTs: null, lastRead: "1791000001.000100" }])
    expect(repo.channelRead(F.C)).toMatchObject({ last_read: "1791000001.000100", unread_count_display: 0, has_unreads: 0, source: "channel_marked" })
    expect(repo.isRead(F.C, "1791000001.000100", null)).toBe(true)
    // Marking unread (moving back) is also applied verbatim, but is not a "read" movement.
    expect(reduceEvent(repo, F.channelMarked("1791000000.000000", 1)).readMoved).toEqual([])
    expect(repo.isRead(F.C, "1791000001.000100", null)).toBe(false)
  })

  test("thread replies use the per-thread cursor, not the channel cursor", () => {
    const repo = setup()
    const parent = "1791000001.000100"
    reduceEvent(repo, F.message(parent, "parent", { user: F.SELF }))
    reduceEvent(repo, F.reply("1791000002.000100", parent, "r1"))
    reduceEvent(repo, F.reply("1791000003.000100", parent, "r2"))
    reduceEvent(repo, F.replied(parent, "1791000003.000100"))
    expect(repo.message(F.C, parent)).toMatchObject({ reply_count: 2, latest_reply: "1791000003.000100", thread_ts: parent })
    expect(repo.threadRead(F.C, parent)).toMatchObject({ subscribed: 1, last_read: parent })
    reduceEvent(repo, F.channelMarked("1791000009.000000"))
    expect(repo.isRead(F.C, "1791000002.000100", parent)).toBe(false)
    const r = reduceEvent(repo, F.threadMarked(parent, "1791000002.000100"))
    expect(r.readMoved).toEqual([{ conversationId: F.C, threadTs: parent, lastRead: "1791000002.000100" }])
    expect(repo.isRead(F.C, "1791000002.000100", parent)).toBe(true)
    expect(repo.isRead(F.C, "1791000003.000100", parent)).toBe(false)
    expect(repo.threadRead(F.C, parent)?.source).toBe("thread_marked")
  })

  test("own messages count as read; im_marked; reactions; unknown events logged", () => {
    const repo = setup()
    reduceEvent(repo, F.message("1791000001.000100", "mine", { user: F.SELF }))
    expect(repo.isRead(F.C, "1791000001.000100", null)).toBe(true)
    reduceEvent(repo, F.imMarked("1791000005.000000"))
    expect(repo.conversation(F.D)?.kind).toBe("im")
    expect(repo.channelRead(F.D)?.last_read).toBe("1791000005.000000")
    reduceEvent(repo, F.reactionAdded("1791000001.000100"))
    expect(repo.sql.all("SELECT name, user_id FROM reactions")).toEqual([{ name: "eyes", user_id: "U0BOB" }])
    reduceEvent(repo, { type: "some_future_event", x: 1 })
    expect(repo.sql.all("SELECT type FROM events WHERE type = 'some_future_event'").length).toBe(1)
  })
})
