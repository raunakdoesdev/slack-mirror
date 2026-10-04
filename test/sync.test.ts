import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Sync from "../src/ingest/sync.ts"
import * as F from "./fixtures/rtm.ts"
import { fakeSlack, layerFor, newRepo, nowTs } from "./helpers.ts"

const counts = (latest: string, lastRead: string) => ({
  ok: true,
  threads: { has_unreads: true, mention_count: 0 },
  channels: [{ id: F.C, last_read: lastRead, latest, updated: latest, mention_count: 1, has_unreads: latest > lastRead }],
  mpims: [],
  ims: [{ id: F.D, last_read: "0000000000.000000", latest: null, mention_count: 0, has_unreads: false }],
  channel_badges: { channels: 1, dms: 0, app_dms: 0, thread_mentions: 0, thread_unreads: 1 },
})

describe("sync", () => {
  test("bootstrap stores identity, conversations and mutes", async () => {
    const repo = newRepo()
    const slack = fakeSlack({
      "auth.test": () => ({ ok: true, url: "https://x.slack.com/", team: "Acme", user: "owner", team_id: "T0", user_id: F.SELF }),
      "client.userBoot": () => ({
        ok: true, self: { id: F.SELF }, team: { id: "T0", name: "Acme", domain: "acme" },
        channels: [{ id: F.C, name: "general", is_channel: true }, { id: "C0MUTED", name: "noise", is_channel: true }],
        ims: [{ id: F.D, user: "U0ALICE", is_im: true }],
        subteams: { self: ["S0ENG"] },
        prefs: { all_notifications_prefs: JSON.stringify({ channels: { C0MUTED: { muted: true } } }) },
      }),
      "users.conversations": (p) => p.cursor
        ? { ok: true, channels: [{ id: "C0EXTRA", name: "beyond-boot-cap", is_channel: true }] }
        : { ok: true, channels: [{ id: F.C, name: "general" }], response_metadata: { next_cursor: "n" } },
    })
    repo.upsertConversation({ id: "C0LEFT", name: "left-long-ago" })
    const r = await Effect.runPromise(Sync.bootstrap.pipe(Effect.provide(layerFor(repo, slack))))
    expect(r).toEqual({ channels: 2, ims: 1, member: 4 })
    expect(repo.conversation("C0EXTRA")?.is_member).toBe(1)
    expect(repo.conversation("C0LEFT")?.is_member).toBe(0)
    expect(repo.conversation("C0MUTED")?.is_muted).toBe(1)
    expect(repo.conversation(F.D)).toMatchObject({ kind: "im", im_user_id: "U0ALICE" })
    expect(repo.identity()?.groupIds).toEqual(["S0ENG"])
  })

  test("reconcile: counts set read state, detect gaps and fill history + threads within the window", async () => {
    const repo = newRepo()
    const t1 = nowTs(-3600), t2 = nowTs(-1800), r1 = nowTs(-1700), old = nowTs(-5 * 86400)
    repo.upsertMessage(F.C, { ts: t1, user: "U0ALICE", text: "already have" })
    repo.sql.run("INSERT INTO sync_state (conversation_id, newest_ts, updated_at) VALUES (?, ?, ?)", F.C, t1, Date.now())
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const slack = fakeSlack({
      "client.counts": () => counts(t2, t1),
      "subscriptions.thread.getView": () => ({
        ok: true, has_more: false, total_unread_replies: 1,
        threads: [{ root_msg: { ts: t2, channel: F.C, user: F.SELF, text: "q?", reply_count: 1, latest_reply: r1, subscribed: true, last_read: t2, thread_ts: t2 },
          unread_replies: [{ ts: r1, thread_ts: t2, user: "U0ALICE", text: "answer" }] }],
      }),
      "conversations.history": (p) => ({ ok: true, has_more: false, messages: [
        { ts: t2, user: F.SELF, text: "q?", reply_count: 1, latest_reply: r1, thread_ts: t2 },
        ...(String(p.oldest) < old ? [{ ts: old, text: "too old" }] : []),
      ] }),
      "conversations.replies": () => ({ ok: true, messages: [{ ts: t2, thread_ts: t2, user: F.SELF, text: "q?" }, { ts: r1, thread_ts: t2, user: "U0ALICE", text: "answer" }] }),
    }, calls)
    const r = await Effect.runPromise(Sync.reconcile().pipe(Effect.provide(layerFor(repo, slack))))
    expect(repo.channelRead(F.C)).toMatchObject({ last_read: t1, latest: t2, has_unreads: 1, mention_count: 1 })
    expect(repo.threadRead(F.C, t2)).toMatchObject({ subscribed: 1, last_read: t2, unread_count: 1 })
    expect(calls.find((c) => c.method === "conversations.history")?.params.oldest).toBe(t1) // resume from the watermark, not from the (newer) thread-view root
    expect(repo.message(F.C, r1)?.is_reply).toBe(1)
    expect(r.filled).toBe(1)
    expect(r.newMessages.map((m) => m.ts).sort()).toEqual([r1, t2].sort())
    expect(repo.sql.all("SELECT thread_unreads FROM badges")).toEqual([{ thread_unreads: 1 }])
  })

  test("thread view absence marks previously-unread threads as read elsewhere", async () => {
    const repo = newRepo()
    const t = nowTs(-100)
    repo.patchThreadRead(F.C, t, { subscribed: true, last_read: t, unread_count: 2 }, "test")
    const slack = fakeSlack({ "subscriptions.thread.getView": () => ({ ok: true, has_more: false, threads: [] }) })
    const r = await Effect.runPromise(Sync.reconcileThreads().pipe(Effect.provide(layerFor(repo, slack))))
    expect(repo.threadRead(F.C, t)?.unread_count).toBe(0)
    expect(r.readMoved).toEqual([{ conversationId: F.C, threadTs: t, lastRead: "" }])
  })

  test("history starts at the 48h window when nothing is stored", async () => {
    const repo = newRepo()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const slack = fakeSlack({ "conversations.history": () => ({ ok: true, messages: [] }) }, calls)
    await Effect.runPromise(Sync.fillConversation(F.C).pipe(Effect.provide(layerFor(repo, slack))))
    const oldest = Number(calls[0]?.params.oldest)
    expect(Math.abs(oldest - (Date.now() / 1000 - 48 * 3600))).toBeLessThan(5)
  })

  test("unread conversations backfill past the window down to last_read, resumably", async () => {
    const repo = newRepo()
    const now = Date.now() / 1000
    const ts = (daysAgo: number) => (now - daysAgo * 86400).toFixed(6)
    const all = [9, 8, 5, 4, 3, 2, 1, 0.5, 0.1].map(ts) // last_read is the 5-days-ago message
    const lastRead = all[2]!
    const history = (p: Record<string, unknown>) => {
      const inRange = all.filter((t) => t >= String(p.oldest) && (!p.latest || t <= String(p.latest))).reverse()
      const off = Number(p.cursor ?? 0)
      const msgs = inRange.slice(off, off + 2)
      const more = off + 2 < inRange.length
      return { ok: true, has_more: more, messages: msgs.map((t) => ({ ts: t, user: "U0ALICE", text: t })), response_metadata: { next_cursor: more ? String(off + 2) : "" } }
    }
    const slack = fakeSlack({ "conversations.history": history })
    repo.patchChannelRead(F.C, { last_read: lastRead, latest: all.at(-1)!, has_unreads: true }, "test")
    const cfg = { ...Sync.defaultSyncConfig, maxPagesPerFill: 1 }
    const run = () => Effect.runPromise(Sync.fillConversation(F.C, cfg).pipe(Effect.provide(layerFor(repo, slack))))
    let r = await run()
    expect(r.complete).toBe(false)
    for (let i = 0; i < 6 && !r.complete; i++) r = await run()
    expect(r.complete).toBe(true)
    const stored = repo.sql.all<{ ts: string }>("SELECT ts FROM messages WHERE conversation_id = ? ORDER BY ts", F.C).map((m) => m.ts)
    expect(stored).toEqual(all.slice(2))
    expect(repo.sql.all<Record<string, unknown>>("SELECT oldest_ts, newest_ts FROM sync_state WHERE conversation_id = ?", F.C)[0]).toEqual({ oldest_ts: lastRead, newest_ts: all.at(-1) })
  })
})
