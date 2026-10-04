// Writes .dev.vars for `wrangler dev` from the session captured by `bun run login`.
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { SESSION_PATH } from "./session.ts"

const s = JSON.parse(readFileSync(SESSION_PATH, "utf8")) as { token: string; cookie: string }
const prev = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : ""
const key = prev.match(/^SESSION_KEY=(.+)$/m)?.[1] ?? randomBytes(24).toString("hex")
writeFileSync(".dev.vars", `SESSION_KEY=${key}\nSLACK_TOKEN=${s.token}\nSLACK_COOKIE=${s.cookie}\n`, { mode: 0o600 })
console.log("wrote .dev.vars (mode 600).")
