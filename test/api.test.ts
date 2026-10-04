import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { handleApi } from "../src/api/http.ts"
import { handleMcp } from "../src/api/mcp.ts"
import * as Q from "../src/api/queries.ts"
import type { ApiActions } from "../src/api/tools.ts"
import { reduceEvent } from "../src/ingest/reduce.ts"
import { makeSlackApi, markConversation, SlackApi } from "../src/slack/api.ts"
import * as F from "./fixtures/rtm.ts"
import { newRepo, nowTs } from "./helpers.ts"

const actions = (over: Partial<ApiActions> = {}): ApiActions => ({
  markRead: () => Effect.succeed(undefined),
  setSession: () => Effect.succeed({}),
  reconcileNow: () => Effect.void,
  windows: { channelHours: 48, dmHours: 336, threadHours: 336 },
  ...over,
})
type Repo = ReturnType<typeof newRepo>
const call = (repo: Repo, method: string, path: string, body?: unknown, a = actions()) =>
  Effect.runPromise(handleApi(repo, new Request(`http://x${path}`, { method, body: body ? JSON.stringify(body) : undefined }), a))
    .then(async (r) => ({ status: r.status, body: (await r.json()) as any }))
const rpc = (repo: Repo, body: unknown, a = actions()) =>
  Effect.runPromise(handleMcp(repo, new Request("http://x/mcp", { method: "POST", body: JSON.stringify(body) }), a)).then((r) => r.json() as Promise<any>)
const tool = (repo: Repo, name: string, args: Record<string, unknown> = {}, a = actions()) =>
  rpc(repo, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, a).then((r) => r.result)

const seed = () => {
  const repo = newRepo()
  repo.setIdentity({ selfUserId: F.SELF, teamId: "T0", groupIds: [] }, { domain: "acme" })
  repo.upsertUser({ id: "U0ALICE", name: "alice", real_name: "Alice Doe", profile: { display_name: "alice", email: "alice@acme.test" } } as any)
  repo.upsertUser({ id: "U0EXT", name: "ext", real_name: "Erin External", team_id: "T9", is_stranger: true, profile: { email: "erin@acme.com" } } as any)
  repo.upsertUser({ id: F.SELF, name: "owner", real_name: "Owner", profile: { email: "owner@acme.test" } } as any)
  repo.upsertConversation({ id: "C0EXT", name: "acme-globex", is_channel: true, is_ext_shared: true, is_shared: true } as any)
  const a = nowTs(-600), b = nowTs(-500), p = nowTs(-400), r1 = nowTs(-300), x = nowTs(-200)
  reduceEvent(repo, F.message(a, "deploy finished fine"))
  reduceEvent(repo, F.message(b, `<@${F.SELF}> can you review the invoice parser?`))
  reduceEvent(repo, F.message(p, "thread parent", { user: F.SELF }))
  reduceEvent(repo, F.replied(p, r1))
  reduceEvent(repo, F.reply(r1, p, "reply in your thread"))
  reduceEvent(repo, F.reactionAdded(b, "eyes"))
  reduceEvent(repo, F.botMessage(nowTs(-100)))
  reduceEvent(repo, F.channelMarked(a, 2, 1))
  reduceEvent(repo, { ...F.message(x, "can you send the MSA?", { user: "U0EXT" }), channel: "C0EXT" })
  return { repo, a, b, p, r1, x }
}

describe("agent tools", () => {
  test("tools/list: generic primitives with annotations, MCP instructions", async () => {
    const { repo } = seed()
    const init = await rpc(repo, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    expect(init.result.protocolVersion).toBe("2025-06-18")
    expect(init.result.instructions).toContain("status")
    const tools = (await rpc(repo, { jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools
    expect(tools.map((t: any) => t.name)).toEqual(["status", "list_conversations", "unread", "get_conversation", "get_thread", "search", "users", "describe_schema", "sql", "mark_read"])
    for (const t of tools) expect(t.annotations.readOnlyHint).toBe(t.name !== "mark_read")
    expect(tools.find((t: any) => t.name === "mark_read").annotations.destructiveHint).toBe(true)
  })

  test("unread: Slack read state with latest unread messages, names and permalinks", async () => {
    const { repo, b } = seed()
    const u = (await tool(repo, "unread")).structuredContent
    const general = u.conversations.find((c: any) => c.id === F.C)
    expect(general).toMatchObject({ name: "general", has_unreads: true, mention_count: 1, my_last_post_ts: expect.any(String) })
    expect(general.latest_unread.map((m: any) => m.ts)).toContain(b)
    const m = general.latest_unread.find((x: any) => x.ts === b)
    expect(m.text).toBe(`<@${F.SELF}|Owner> can you review the invoice parser?`)
    expect(m.user_name).toBe("alice")
    expect(m.permalink).toBe(`https://acme.slack.com/archives/${F.C}/p${b.replace(".", "")}`)
    expect(m.reactions).toEqual([{ name: "eyes", count: 1, users: ["U0BOB"] }])
  })

  test("get_conversation and get_thread", async () => {
    const { repo, a, b, p, r1 } = seed()
    const c = (await call(repo, "GET", `/v1/get_conversation?channel=%23general&limit=2`)).body
    expect(c.conversation).toMatchObject({ id: F.C, type: "channel", last_read: a })
    expect(c.items.map((m: any) => m.text)).toEqual(["deploy ok", "parent"])
    expect(c.next_cursor).toBe("2")
    const c2 = (await call(repo, "GET", `/v1/get_conversation?channel=general&cursor=2`)).body
    expect(c2.items.map((m: any) => m.ts)).toEqual([b, a])
    expect(c.items[1]).toMatchObject({ ts: p, reply_count: 2, latest_reply: r1, reply_users: [{ id: "U0ALICE", name: "alice" }] })
    const t = (await call(repo, "GET", `/v1/get_thread?channel=${F.C}&ts=${p}`)).body
    expect(t.items.map((m: any) => m.ts)).toEqual([p, r1])
    expect(t.read_state).toMatchObject({ subscribed: true, last_read: p })
    expect(t.items[1].permalink).toContain(`?thread_ts=${p}`)
  })

  test("search filters: text, from, mentions_me, type, bots, time", async () => {
    const { repo, b, x } = seed()
    const s = (q: string) => call(repo, "GET", `/v1/search?${q}`).then((r) => r.body)
    expect((await s("query=invoice%20parser")).items[0]).toMatchObject({ ts: b, snippet: expect.stringContaining("[invoice]") })
    expect((await s("mentions_me=true")).items.map((m: any) => m.ts)).toEqual([b])
    expect((await s("from=erin@acme.com")).items.map((m: any) => m.ts)).toEqual([x])
    expect((await s("type=ext_shared")).items.map((m: any) => m.channel.name)).toEqual(["acme-globex"])
    expect((await s("query=deploy")).items.map((m: any) => m.text)).toEqual(["deploy finished fine"])
    expect((await s("query=deploy&include_bots=true")).count).toBe(2)
    expect((await s("since=1h&until=" + b)).count).toBe(2)
    expect((await call(repo, "GET", "/v1/search?since=whenever")).status).toBe(400)
  })

  test("list_conversations and users", async () => {
    const { repo, p } = seed()
    const all = (await call(repo, "GET", "/v1/list_conversations")).body
    expect(all.items.map((c: any) => c.id).sort()).toEqual([F.C, "C0EXT"].sort())
    expect(all.items.find((c: any) => c.id === F.C).my_last_post_ts).toBe(p)
    expect((await call(repo, "GET", "/v1/list_conversations?type=ext_shared")).body.items.map((c: any) => c.id)).toEqual(["C0EXT"])
    expect((await call(repo, "GET", "/v1/list_conversations?unread=true")).body.items.map((c: any) => c.id)).toEqual([F.C])
    const ext = (await call(repo, "GET", "/v1/users?external=true")).body.items
    expect(ext).toEqual([expect.objectContaining({ id: "U0EXT", email: "erin@acme.com", is_external: true, team_id: "T9" })])
    expect((await call(repo, "GET", "/v1/users?query=alice@")).body.items[0].id).toBe("U0ALICE")
  })

  test("status reports health and per-type coverage", async () => {
    const { repo } = seed()
    const st = (await tool(repo, "status")).structuredContent
    expect(st.auth_error).toBeNull()
    expect(st.windows_hours).toMatchObject({ channel: 48, im: 336, ext_shared: 336 })
    expect(st.coverage.map((c: any) => c.type).sort()).toEqual(["channel", "ext_shared"])
  })

  test("read-only SQL rejects writes and never persists; schema is documented", async () => {
    const { repo } = seed()
    expect((await call(repo, "POST", "/v1/sql", { query: "SELECT count(*) AS n FROM messages" })).body.items).toEqual([{ n: 6 }])
    for (const q of ["DELETE FROM messages", "SELECT 1; DELETE FROM messages", "WITH x AS (SELECT 1) UPDATE messages SET text = 'x'", "PRAGMA table_info(messages)"]) {
      expect((await call(repo, "POST", "/v1/sql", { query: q })).status).toBe(400)
    }
    expect(Q.readOnlySql(repo, "SELECT text FROM messages WHERE text LIKE '%delete%'")).toEqual([])
    expect(repo.sql.all("SELECT count(*) AS n FROM messages")).toEqual([{ n: 6 }])
    const schema = (await tool(repo, "describe_schema")).structuredContent
    expect(schema.tables.find((t: any) => t.name === "thread_reads").description).toContain("subscribed")
    expect(schema.tables.map((t: any) => t.name)).not.toContain("notifications")
  })

  test("mark_read validates input, resolves names and requires POST over HTTP", async () => {
    const { repo, b } = seed()
    const seen: unknown[] = []
    const a = actions({ markRead: (p) => Effect.sync(() => void seen.push(p)) })
    expect((await call(repo, "GET", `/v1/mark_read?channel=general&ts=${b}`, undefined, a)).status).toBe(405)
    expect((await call(repo, "POST", "/v1/mark_read", { channel: "general", ts: "nope" }, a)).status).toBe(400)
    expect((await call(repo, "POST", "/v1/mark_read", { channel: "general", ts: b }, a)).body).toMatchObject({ ok: true, channel: F.C })
    expect(seen).toEqual([{ channel: F.C, ts: b, threadTs: undefined }])
  })

  test("Slack client refuses non-allowlisted methods and mark methods unless allowed", async () => {
    const api = makeSlackApi({ kind: "session", token: "xoxc-x", cookie: "xoxd-x" }, { apiBase: "http://127.0.0.1:1/", allowMarkRead: false })
    const send = await Effect.runPromise(api.call("chat.postMessage", Schema.Unknown, { channel: "C", text: "hi" }).pipe(Effect.flip))
    expect(send._tag).toBe("SlackWriteForbidden")
    const mark = await Effect.runPromise(markConversation(F.C, "1.000000").pipe(Effect.provideService(SlackApi, api), Effect.flip))
    expect(mark._tag).toBe("SlackWriteForbidden")
  })

  test("responses are size-capped with a resumable cursor", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ i, pad: "x".repeat(4000) }))
    const p = Q.page(rows, 50, 10)
    expect(JSON.stringify(p.items).length).toBeLessThanOrEqual(Q.MAX_BYTES)
    expect(p.next_cursor).toBe(String(10 + p.count))
    expect(Q.parseTime("48h")! < Q.parseTime("1h")!).toBe(true)
  })
})
