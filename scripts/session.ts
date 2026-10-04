import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import type { SlackCredentials } from "../src/slack/api.ts"

export const SESSION_PATH = `${homedir()}/.slack-mirror/session.json`

export const loadSession = (): { creds: SlackCredentials; domain: string } => {
  const s = JSON.parse(readFileSync(SESSION_PATH, "utf8")) as { token: string; cookie: string; domain: string }
  return { creds: { kind: "session", token: s.token, cookie: s.cookie }, domain: s.domain }
}
