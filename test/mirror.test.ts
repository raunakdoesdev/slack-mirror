import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { defaultMirrorConfig, runMirror } from "../src/ingest/mirror.ts"
import { SlackApi } from "../src/slack/api.ts"
import { SocketFactory, type Socket } from "../src/slack/rtm.ts"
import { Store } from "../src/store/store.ts"
import * as F from "./fixtures/rtm.ts"
import { fakeSlack, newRepo, nowTs } from "./helpers.ts"

/** Scriptable fake websocket. */
class FakeSocket implements Socket {
  sent: string[] = []
  private l: Record<string, Array<(e: any) => void>> = {}
  addEventListener(t: string, f: (e: any) => void) { (this.l[t] ??= []).push(f) }
  emit(e: unknown) { this.l.message?.forEach((f) => f({ data: JSON.stringify(e) })) }
  drop() { this.l.close?.forEach((f) => f({ code: 1006, reason: "network" })) }
  send(d: string) { this.sent.push(d) }
  close() {}
}

const waitFor = async (f: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("runMirror", () => {
  test("streams realtime events, reconnects after a drop and gap-fills what was missed", async () => {
    const repo = newRepo()
    const sockets: FakeSocket[] = []
    const t1 = nowTs(-60), missed = nowTs(-30), t3 = nowTs(-10)
    let latest = t1
    const history: Array<{ ts: string; user: string; text: string }> = []
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const slack = fakeSlack({
      "auth.test": () => ({ ok: true, url: "u", team: "Acme", user: "owner", team_id: "T0", user_id: F.SELF }),
      "client.userBoot": () => ({ ok: true, self: { id: F.SELF }, team: { id: "T0" }, channels: [{ id: F.C, name: "general" }], ims: [] }),
      "users.list": () => ({ ok: true, members: [] }),
      "users.conversations": () => ({ ok: true, channels: [{ id: F.C, name: "general" }] }),
      "rtm.connect": () => ({ ok: true, url: "wss://fake" }),
      "client.counts": () => ({ ok: true, channels: [{ id: F.C, last_read: "0000000000.000000", latest, has_unreads: true }], mpims: [], ims: [] }),
      "subscriptions.thread.getView": () => ({ ok: true, has_more: false, threads: [] }),
      "conversations.history": (p) => ({ ok: true, messages: history.filter((m) => !p.oldest || m.ts >= String(p.oldest)) }),
    }, calls)
    const layer = Layer.mergeAll(
      Layer.succeed(Store, repo),
      Layer.succeed(SlackApi, slack),
      Layer.succeed(SocketFactory, { open: () => Effect.sync(() => { const s = new FakeSocket(); sockets.push(s); return s }) }),
    )
    const cfg = { ...defaultMirrorConfig, rtm: { pingEveryMs: 50, staleAfterMs: 10_000 }, housekeepingEveryMs: 20 }
    const fiber = Effect.runFork(runMirror(cfg).pipe(Effect.provide(layer)))
    try {
      await waitFor(() => sockets.length === 1)
      sockets[0]!.emit(F.hello)
      history.push({ ts: t1, user: "U0ALICE", text: "first" })
      sockets[0]!.emit(F.message(t1, "first"))
      await waitFor(() => !!repo.message(F.C, t1))
      await waitFor(() => sockets[0]!.sent.some((s) => s.includes('"ping"')))

      // Connection drops; a message arrives while we're offline.
      sockets[0]!.drop()
      history.push({ ts: missed, user: "U0ALICE", text: "sent while offline" })
      latest = missed
      await waitFor(() => sockets.length === 2, 5000)
      expect(repo.getMeta("rtm_last_error")).toContain("closed")
      sockets[1]!.emit(F.hello)
      await waitFor(() => !!repo.message(F.C, missed), 5000)
      sockets[1]!.emit(F.message(t3, "after reconnect"))
      sockets[1]!.emit(F.channelMarked(t3))
      await waitFor(() => repo.channelRead(F.C)?.last_read === t3)
      expect(repo.message(F.C, t3)?.text).toBe("after reconnect")
      expect(repo.getMeta("rtm_state")).toBe("connected")
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
    }
  }, 15_000)
})
