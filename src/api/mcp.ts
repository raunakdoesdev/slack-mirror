import { Effect } from "effect"
import type { Repo } from "../store/store.ts"
import { INSTRUCTIONS, TOOLS, toolByName, type ApiActions } from "./tools.ts"

/** MCP server: stateless JSON-RPC over streamable HTTP (JSON responses). */

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

const listTools = () =>
  TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.readOnly
      ? { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      : { title: t.title, readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }))

interface RpcRequest { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> }

export const callTool = (repo: Repo, actions: ApiActions, name: string, args: Record<string, unknown>) => {
  const tool = toolByName(name)
  return tool ? tool.run(repo, actions, args) : Effect.fail(new Error(`unknown tool ${name}`))
}

export const handleMcp = (repo: Repo, req: Request, actions: ApiActions): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (req.method !== "POST") return new Response("MCP endpoint: POST JSON-RPC", { status: 405, headers: { allow: "POST" } })
    const body = (yield* Effect.promise(() => req.json().catch(() => null))) as RpcRequest | RpcRequest[] | null
    if (!body) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 })
    const one = (r: RpcRequest): Effect.Effect<unknown | undefined> =>
      Effect.gen(function* () {
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id ?? null, result })
        switch (r.method) {
          case "initialize": {
            const asked = r.params?.protocolVersion as string | undefined
            return ok({
              protocolVersion: asked && SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "slack-mirror", title: "Slack mirror", version: "0.2.0" },
              instructions: INSTRUCTIONS,
            })
          }
          case "ping":
            return ok({})
          case "tools/list":
            return ok({ tools: listTools() })
          case "tools/call": {
            const name = String(r.params?.name ?? "")
            const res = yield* callTool(repo, actions, name, (r.params?.arguments ?? {}) as Record<string, unknown>).pipe(
              Effect.catchAllDefect((d) => Effect.fail(new Error(String(d)))),
              Effect.either,
            )
            return ok(res._tag === "Right"
              ? { content: [{ type: "text", text: JSON.stringify(res.right) }], structuredContent: res.right }
              : { content: [{ type: "text", text: res.left.message }], isError: true })
          }
        }
        if (r.id === undefined) return undefined // notification
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `method not found: ${r.method}` } }
      })
    if (Array.isArray(body)) {
      const out = (yield* Effect.all(body.map(one))).filter((x) => x !== undefined)
      return out.length ? Response.json(out) : new Response(null, { status: 202 })
    }
    const out = yield* one(body)
    return out === undefined ? new Response(null, { status: 202 }) : Response.json(out)
  })
