import { Effect } from "effect"
import type { Repo } from "../store/store.ts"
import { callTool } from "./mcp.ts"
import { QueryError, ReadOnlySqlError } from "./queries.ts"
import { TOOLS, ToolError, toolByName, type ApiActions } from "./tools.ts"

export type { ApiActions } from "./tools.ts"

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } })

/** Query-string args, coerced using the tool's JSON schema (numbers, booleans, arrays). */
const queryArgs = (u: URL, schema: Record<string, unknown>) => {
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>
  const out: Record<string, unknown> = {}
  for (const k of new Set(u.searchParams.keys())) {
    const all = u.searchParams.getAll(k)
    const v = all.at(-1)!
    const t = props[k]?.type
    out[k] = t === "integer" || t === "number" ? Number(v) : t === "boolean" ? ["1", "true", "yes"].includes(v) : t === "array" ? all.flatMap((x) => x.split(",")) : v
  }
  return out
}

/**
 * JSON API: every MCP tool is also `GET|POST /v1/<tool>` (query params or JSON body).
 * Auth (OAuth bearer) is enforced by the Worker before this runs.
 */
export const handleApi = (repo: Repo, req: Request, actions: ApiActions): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const u = new URL(req.url)
    const name = u.pathname.replace(/^\/v1\//, "").replace(/\/$/, "")
    if (name === "" || name === "tools") return json({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, read_only: t.readOnly, input_schema: t.inputSchema })) })
    const body = req.method === "POST" ? ((yield* Effect.promise(() => req.json().catch(() => ({})))) as Record<string, unknown>) : {}
    if (req.method === "POST" && name === "auth/session") {
      const { token, cookie } = body as { token?: string; cookie?: string }
      if (!token?.startsWith("xoxc-") || !cookie?.startsWith("xoxd-")) return json({ error: "token must be xoxc-…, cookie must be the d cookie (xoxd-…)" }, 400)
      const r = yield* actions.setSession({ token, cookie }).pipe(Effect.either)
      return r._tag === "Right" ? json({ ok: true, ...(r.right as object) }) : json({ ok: false, error: r.left._tag, message: r.left.message }, 400)
    }
    if (req.method === "POST" && name === "reconcile") {
      yield* actions.reconcileNow()
      return json({ ok: true })
    }
    const tool = toolByName(name === "mark" ? "mark_read" : name)
    if (!tool) return json({ error: "not found", tools: TOOLS.map((t) => t.name) }, 404)
    if (!tool.readOnly && req.method !== "POST") return json({ error: `${tool.name} requires POST` }, 405)
    const args = req.method === "POST" ? body : queryArgs(u, tool.inputSchema)
    const r = yield* callTool(repo, actions, tool.name, args).pipe(Effect.either)
    if (r._tag === "Right") return json(r.right)
    const e = r.left
    const client = e instanceof QueryError || e instanceof ReadOnlySqlError || e instanceof ToolError
    return json({ error: e.message }, client ? 400 : 500)
  }).pipe(Effect.catchAllDefect((d) => Effect.succeed(json({ error: String(d) }, 500))))
