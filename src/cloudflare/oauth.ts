import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider"
import type { Env } from "./worker.ts"

/**
 * OAuth 2.1 authorization server + protected resource (one Worker).
 * /mcp and /v1/* accept only tokens issued here. /authorize is served only on
 * AUTH_HOST, which must sit behind an access gateway, and only to the owner's identity it forwards.
 */

const SCOPE = "slack"

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers }

const toMirror = {
  fetch(req: Request, env: Env) {
    return env.MIRROR.get(env.MIRROR.idFromName("default")).fetch(req)
  },
}

const html = (body: string, status = 200, headers?: Headers) => {
  const h = new Headers(headers)
  h.set("content-type", "text/html; charset=utf-8")
  h.set("cache-control", "no-store")
  h.set("x-frame-options", "DENY")
  h.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*")
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>slack-mirror</title>
<body style="font:15px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem">${body}</body>`, { status, headers: h })
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The gateway-forwarded identity, if it is the owner. Only trusted on AUTH_HOST, where the gateway sets these headers. */
export const ownerIdentity = (req: Request, env: Env): { email: string } | null => {
  if (new URL(req.url).hostname !== env.AUTH_HOST) return null
  const email = req.headers.get(env.IDENTITY_EMAIL_HEADER ?? "cf-access-authenticated-user-email")?.toLowerCase()
  if (!email || email !== env.OWNER_EMAIL.toLowerCase()) return null
  const required = JSON.parse(env.IDENTITY_REQUIRE || "{}") as Record<string, string>
  if (Object.entries(required).some(([h, v]) => req.headers.get(h) !== v)) return null
  return { email }
}

const authorize = async (req: Request, env: OAuthEnv): Promise<Response> => {
  const who = ownerIdentity(req, env)
  if (!who) return html("<h1>Forbidden</h1><p>Only the mirror's owner can authorize clients.</p>", 403)
  const oauth = env.OAUTH_PROVIDER
  try {
    if (req.method === "POST") {
      const form = await req.formData()
      const handle = String(form.get("handle") ?? "")
      if (form.get("action") !== "approve") {
        const denied = await oauth.denyConsent(req, handle)
        return new Response(null, { status: 302, headers: denied.headers })
      }
      const approved = await oauth.approveConsent(req, handle, { scope: [SCOPE] })
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: encodeURIComponent(who.email),
        scope: [SCOPE],
        metadata: { approved_by: who.email, at: new Date().toISOString() },
        props: { email: who.email },
      })
      const headers = new Headers(approved.headers)
      headers.set("location", redirectTo)
      return new Response(null, { status: 302, headers })
    }
    const request = await oauth.parseAuthRequest(req)
    const d = await oauth.describeConsent(request)
    const tx = await oauth.beginConsent(request)
    return html(`<h1>Connect to your Slack mirror?</h1>
<p><b>${esc(d.clientName)}</b>${d.clientDomain ? ` (${esc(d.clientDomain)})` : " <small>(name is self-asserted)</small>"} wants to read your mirrored Slack data and mark conversations read on your behalf.</p>
<p>Tokens will be sent to <b>${esc(d.redirectHost)}</b>.${d.redirectIsLoopback ? " <br><b>Warning:</b> this is a local address; any program on that machine could receive the token." : ""}</p>
<p>Signed in as ${esc(who.email)}.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(tx.handle)}">
<button name="action" value="approve" style="font-size:1rem;padding:.5rem 1rem">Approve</button>
<button name="action" value="deny" style="font-size:1rem;padding:.5rem 1rem">Deny</button></form>`, 200, tx.headers)
  } catch (e) {
    return html(`<h1>Invalid authorization request</h1><p>${esc(e instanceof Error ? e.message : String(e))}</p>`, 400)
  }
}

const defaultHandler = {
  async fetch(req: Request, e: Env): Promise<Response> {
    const env = e as OAuthEnv
    const url = new URL(req.url)
    if (url.pathname === "/authorize") {
      if (url.hostname !== env.AUTH_HOST) return Response.redirect(`https://${env.AUTH_HOST}/authorize${url.search}`, 302)
      return authorize(req, env)
    }
    return new Response("not found", { status: 404 })
  },
}

let provider: OAuthProvider<Env> | undefined
const providerFor = (env: Env) =>
  (provider ??= new OAuthProvider<Env>({
    apiHandlers: { "/mcp": toMirror, "/v1/": toMirror },
    defaultHandler,
    authorizeEndpoint: `https://${env.AUTH_HOST}/authorize`,
    tokenEndpoint: `${env.PUBLIC_URL}/oauth/token`,
    clientRegistrationEndpoint: `${env.PUBLIC_URL}/oauth/register`,
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: {
      resource: env.PUBLIC_URL,
      authorization_servers: [env.PUBLIC_URL],
      bearer_methods_supported: ["header"],
      resource_name: "slack-mirror",
    },
    accessTokenTTL: 3600,
    refreshTokenTTL: 90 * 24 * 3600,
  }))

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return providerFor(env).fetch(req, env, ctx)
  },
} satisfies ExportedHandler<Env>
