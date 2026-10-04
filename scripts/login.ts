/**
 * Capture a Slack web-client session (xoxc token + `d` cookie) from a Chrome
 * window you are signed into, then hand it to slack-mirror.
 *
 *   bun run login --workspace acme     # launches Chrome at acme.slack.com, you sign in, creds saved
 *   bun run login --cdp http://localhost:9222   # reuse an already-running Chrome
 *   bun run login --push https://slack-mirror.<you>.workers.dev  # also upload (needs MIRROR_OAUTH_TOKEN, an OAuth access token)
 *
 * Nothing is sent anywhere except the slack-mirror Worker you pass with --push.
 */
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Cdp } from "./cdp.ts"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const workspace = flag("workspace") ?? process.env["SLACK_WORKSPACE"]
const dir = join(homedir(), ".slack-mirror")
const credsPath = flag("out") ?? join(dir, "session.json")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cdpEndpoint(): Promise<string> {
  const given = flag("cdp")
  if (given) return given
  const port = 9333
  const chrome = process.env["CHROME"] ?? (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "google-chrome")
  const profile = join(dir, "chrome-profile")
  mkdirSync(profile, { recursive: true })
  // A normal (non-automation) Chrome with its own profile: SSO providers
  // treat it like any other browser. You sign in by hand.
  spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run",
    workspace ? `https://${workspace}.slack.com/` : "https://slack.com/signin"], { stdio: "ignore", detached: true }).unref()
  console.log(`Opened Chrome. Sign in to ${workspace ? `${workspace}.slack.com` : "your workspace"} and open it in the browser (not the desktop app).`)
  return `http://127.0.0.1:${port}`
}

type Session = { token: string; cookie: string; teamId: string; domain: string; capturedAt: string }

async function capture(endpoint: string): Promise<Session | undefined> {
  const version = await (await fetch(`${endpoint}/json/version`)).json() as { webSocketDebuggerUrl: string }
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  try {
    const { cookies } = await cdp.send<{ cookies: Array<{ name: string; value: string; domain: string }> }>("Storage.getCookies")
    const d = cookies.find((c) => c.name === "d" && c.domain.endsWith("slack.com"))
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>("Target.getTargets")
    const page = targetInfos.find((t) => t.type === "page" && t.url.startsWith("https://app.slack.com/client"))
    if (!d || !page) return undefined
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true })
    const expr = `(() => { const c = JSON.parse(localStorage.localConfig_v2 || "{}"); return JSON.stringify(Object.values(c.teams || {}).map(t => ({ id: t.id, domain: t.domain, token: t.token, enterprise_id: t.enterprise_id }))) })()`
    const res = await cdp.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId)
    const teams = JSON.parse(res.result.value ?? "[]") as Array<{ id: string; domain: string; token: string }>
    const team = teams.find((t) => t.domain === workspace) ?? teams[0]
    if (!team?.token?.startsWith("xoxc-")) return undefined
    return { token: team.token, cookie: decodeURIComponent(d.value), teamId: team.id, domain: team.domain, capturedAt: new Date().toISOString() }
  } finally {
    cdp.close()
  }
}

const endpoint = await cdpEndpoint()
let session: Session | undefined
for (let i = 0; i < 600 && !session; i++) {
  session = await capture(endpoint).catch(() => undefined)
  if (!session) await sleep(1000)
}
if (!session) {
  console.error("Timed out waiting for a signed-in app.slack.com tab.")
  process.exit(1)
}

// Verify (read-only) before saving.
const check = await fetch(`https://${session.domain}.slack.com/api/auth.test`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie: `d=${encodeURIComponent(session.cookie)}` },
  body: new URLSearchParams({ token: session.token }),
}).then((r) => r.json() as Promise<{ ok: boolean; user?: string; team?: string; error?: string }>)
if (!check.ok) {
  console.error(`auth.test failed: ${check.error}`)
  process.exit(1)
}
mkdirSync(dir, { recursive: true, mode: 0o700 })
writeFileSync(credsPath, JSON.stringify(session), { mode: 0o600 })
console.log(`Signed in as ${check.user} @ ${check.team}. Session saved to ${credsPath} (mode 600).`)

const push = flag("push")
if (push) {
  const apiToken = process.env["MIRROR_OAUTH_TOKEN"]
  if (!apiToken) throw new Error("set MIRROR_OAUTH_TOKEN (an OAuth access token for the mirror) to push the session")
  const r = await fetch(`${push.replace(/\/$/, "")}/v1/auth/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ token: session.token, cookie: session.cookie }),
  })
  console.log(`push → ${r.status} ${await r.text()}`)
}
process.exit(0)
