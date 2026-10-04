import { Context, Data, Effect, Layer, Stream } from "effect"
import { rtmConnect, sessionHeaders, SlackApi } from "./api.ts"

export class RtmError extends Data.TaggedError("RtmError")<{ readonly message: string; readonly code?: number }> {}

/** Minimal websocket surface shared by Workers (fetch upgrade) and Bun/browsers. */
export interface Socket {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message", f: (e: { data: unknown }) => void): void
  addEventListener(type: "close", f: (e: { code: number; reason: string }) => void): void
  addEventListener(type: "error", f: (e: unknown) => void): void
}

export interface SocketFactoryService {
  readonly open: (url: string, headers: Record<string, string>) => Effect.Effect<Socket, RtmError>
}
export class SocketFactory extends Context.Tag("slack-mirror/SocketFactory")<SocketFactory, SocketFactoryService>() {}

/** Cloudflare Workers outbound websocket via fetch + Upgrade (allows the Cookie header). */
export const WorkersSockets = Layer.succeed(SocketFactory, {
  open: (url, headers) =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), { headers: { ...headers, upgrade: "websocket" } })
        const ws = (res as unknown as { webSocket?: { accept(): void } | null }).webSocket
        if (!ws) throw new Error(`upgrade failed: HTTP ${res.status}`)
        ws.accept()
        return ws as unknown as Socket
      },
      catch: (e) => new RtmError({ message: String(e) }),
    }),
})

/** Bun / Node 22+ WebSocket (Bun accepts a `headers` option). */
export const GlobalSockets = Layer.succeed(SocketFactory, {
  open: (url, headers) =>
    Effect.async<Socket, RtmError>((resume) => {
      const ws = new WebSocket(url, { headers } as never)
      ws.addEventListener("open", () => resume(Effect.succeed(ws as unknown as Socket)), { once: true })
      ws.addEventListener("error", () => resume(Effect.fail(new RtmError({ message: "websocket open failed" }))), { once: true })
    }),
})

export interface RtmOptions {
  readonly pingEveryMs: number
  /** Consider the socket dead if nothing (incl. pong) arrives for this long. */
  readonly staleAfterMs: number
}
export const defaultRtmOptions: RtmOptions = { pingEveryMs: 15_000, staleAfterMs: 45_000 }

/**
 * One realtime session as a Stream of raw JSON events. The stream fails with
 * RtmError on close/stale/goodbye so callers can retry (with gap fill).
 */
export const rtmStream = (opts: RtmOptions = defaultRtmOptions): Stream.Stream<Record<string, unknown>, RtmError, SlackApi | SocketFactory> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const api = yield* SlackApi
      const sockets = yield* SocketFactory
      const { url } = yield* rtmConnect.pipe(Effect.mapError((e) => new RtmError({ message: `rtm.connect: ${e._tag}` })))
      const ws = yield* Effect.acquireRelease(sockets.open(url, sessionHeaders(api.credentials)), (ws) =>
        Effect.sync(() => {
          try {
            ws.close(1000, "bye")
          } catch {
            /* already closed */
          }
        }),
      )
      return Stream.async<Record<string, unknown>, RtmError>((emit) => {
        let last = Date.now()
        let id = 1
        const timer = setInterval(() => {
          if (Date.now() - last > opts.staleAfterMs) {
            void emit.fail(new RtmError({ message: "stale socket" }))
            return
          }
          try {
            ws.send(JSON.stringify({ id: id++, type: "ping" }))
          } catch (e) {
            void emit.fail(new RtmError({ message: `ping failed: ${String(e)}` }))
          }
        }, opts.pingEveryMs)
        ws.addEventListener("message", (e) => {
          last = Date.now()
          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(String(e.data)) as Record<string, unknown>
          } catch {
            return
          }
          void emit.single(msg)
          if (msg.type === "goodbye") void emit.fail(new RtmError({ message: "goodbye" }))
        })
        ws.addEventListener("close", (e) => void emit.fail(new RtmError({ message: `closed: ${e.reason || "no reason"}`, code: e.code })))
        ws.addEventListener("error", () => void emit.fail(new RtmError({ message: "socket error" })))
        return Effect.sync(() => clearInterval(timer))
      })
    }),
  )

