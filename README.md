# slack-mirror

A personal Slack client that is a database. It runs as your own Slack session and keeps a realtime mirror of everything you can see in one workspace (channels, private channels, DMs, group DMs, Slack Connect), **including Slack's own read state per conversation and per thread**, and exposes it to agents over MCP (OAuth 2.1) and an HTTP API.

It is deliberately dumb: it stores raw Slack data and returns it. No triage, ranking, scoring or derived signals; agents do the judgment.

TypeScript + [Effect](https://effect.website) on Cloudflare Workers + one Durable Object with SQLite (FTS5).

```
            ┌───────────────────── MirrorDO (Durable Object, SQLite) ─────────────────────┐
 Slack RTM ─┼─► rtmStream (Effect Stream) ─► reduceEvent ─► SQLite ◄── /mcp, /v1/<tool>     │
 websocket  │        ▲ reconnect + backoff                     ▲                           │
 Slack Web ─┼─► reconcile: client.counts, subscriptions.thread.getView, history gap fill     │
 API        │  alarm every 30s = watchdog (restarts the engine after eviction/deploy)       │
            └───────────────────────────────────────────▲─────────────────────────────────┘
 Worker: OAuthProvider (workers-oauth-provider) ── only OAuth-issued tokens reach the DO
```

## Prior art

Nothing found does all of this (persistent realtime mirror + exact channel/thread read state). Closest, and where the protocol details came from:

- [rusq/slackdump](https://github.com/rusq/slackdump) / [rusq/slackauth](https://github.com/rusq/slackauth) (Go): archive/export with xoxc + `d` cookie, browser login. No realtime, no read state.
- [korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server) (Go): MCP over xoxc/xoxd, unread via `client.counts`. No persistent mirror.
- [wee-slack](https://github.com/wee-slack/wee-slack) (Python): full client. Best reference for read-state sync (`client.userBoot`, `client.counts`, `*_marked`/`thread_marked`, `subscriptions.thread.mark`).

## Auth: web session (xoxc + `d` cookie)

| | User OAuth (xoxp) | Web session (xoxc + `d` cookie), **chosen** |
|---|---|---|
| Channel `last_read`/unread | `conversations.info` per channel (1 call each, rate limited) | `client.counts`: every conversation in one call, plus badges |
| **Thread read state** | Not exposed | `subscriptions.thread.getView`, parent `last_read`/`subscribed`, `thread_marked` events |
| Realtime | Events API/Socket Mode need an app, can't send user read-marker events | RTM websocket: `message*`, `reaction_*`, `channel/im/group/mpim_marked`, `thread_marked`, `thread_(un)subscribed`, … |
| Setup | Create + install a Slack app (may need admin approval) | Sign in once in a browser |
| Stability | Documented, stable | Undocumented. These are the endpoints the official web client uses and wee-slack/slackdump have relied on them for years, but they can change without notice |
| Expiry | Until revoked | Token lives as long as the browser session. Signing out of that browser session, a password reset, or admin session-duration policies kill it. The mirror then reports `auth_error` in `/v1/status`, and you sign in again |
| ToS/risk | Fine | It's your own session acting as you, the same as running a third-party client. Workspace admins can see the session. Slack's ToS frowns on unofficial clients, so there is a small risk an admin or Slack flags it |

The requirement for exact thread read state rules out xoxp. `SLACK_TOKEN=xoxp-…` is accepted as a degraded fallback (no RTM, so no realtime), but the session is the supported path.

**Slack writes:** the client refuses any method that isn't on an explicit read-only allowlist (`src/slack/api.ts`). The only write methods are `conversations.mark` and `subscriptions.thread.mark` (moving your own read cursor), used by the `mark_read` tool.

## Connecting an agent (MCP + OAuth)

- MCP URL: `<PUBLIC_URL>/mcp` (streamable HTTP, JSON responses).
- Discovery: an unauthenticated call returns `401` with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"`; `/.well-known/oauth-authorization-server` lists the endpoints. Dynamic client registration is at `/oauth/register`, tokens at `/oauth/token` (PKCE S256, scope `slack`, access tokens 1h, refresh 90d).
- Consent: the `authorization_endpoint` is `https://<AUTH_HOST>/authorize`. `AUTH_HOST` is a custom domain on the same Worker that you put behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) (or any gateway that sets a trusted identity header). The page only renders when the gateway's email header (`IDENTITY_EMAIL_HEADER`, default `cf-access-authenticated-user-email`) equals `OWNER_EMAIL`, and every header in `IDENTITY_REQUIRE` matches; anyone else gets 403. `/authorize` on any other hostname redirects to `AUTH_HOST`, so identity headers are only trusted behind the gateway.
- `/mcp` and every `/v1/*` route require an OAuth access token. Nothing else is served.

## Tools

The same tools are served over MCP and as `GET|POST /v1/<tool>` (query string or JSON body). Every list has `limit` and `cursor`, time filters take a Slack ts, unix seconds, ISO date or a relative `30m`/`48h`/`14d`, and responses are compact JSON capped at ~60KB with `next_cursor` to continue.

| Tool | |
|---|---|
| `status` | realtime state, last event, auth_error, reconcile, history windows and coverage per conversation type, `unread_coverage` (per unread conversation: stored history range vs last_read; `coverage_detail=true` lists all), Slack badge totals |
| `list_conversations` | conversations with type, members, Slack read state, last activity, your last post ts; filter by type, activity, unread, name, muted/archived |
| `unread` | conversations Slack marks unread with their latest unread messages, plus followed threads with unread replies |
| `get_conversation` | messages of one conversation (by id, `#name`, `@user` or email), full text, reactions, files, reply counts, permalinks |
| `get_thread` | a thread's parent and replies plus its per-thread read state |
| `search` | FTS5 search (or a filtered scan with no query) by channel, sender, mentions of you or someone else, type, time; bots excluded by default |
| `users` | user lookup by id, name, handle or email, including external Slack Connect users |
| `describe_schema` | tables, columns and conventions for `sql` |
| `sql` | one read-only SELECT/WITH, run in a rolled-back transaction, max 1000 rows |
| `mark_read` | **writes to Slack**: moves your read cursor for a conversation (`conversations.mark`) or a thread (`subscriptions.thread.mark`). The only Slack write; every other Slack method outside the read allowlist is refused by the client |

## Deploy

```sh
bun install
cp wrangler.example.jsonc wrangler.jsonc               # your deployment config (gitignored)
bunx wrangler kv namespace create slack-mirror-oauth   # put the id in wrangler.jsonc (OAUTH_KV)
openssl rand -hex 24 | bunx wrangler secret put SESSION_KEY   # encrypts a session pushed via /v1/auth/session
bun run login --workspace <your-workspace>             # Chrome sign-in -> ~/.slack-mirror/session.json
# push the session as secrets, without echoing it:
python3 -c "import json;print(json.load(open('$HOME/.slack-mirror/session.json'))['token'],end='')" | bunx wrangler secret put SLACK_TOKEN
python3 -c "import json;print(json.load(open('$HOME/.slack-mirror/session.json'))['cookie'],end='')" | bunx wrangler secret put SLACK_COOKIE
bunx wrangler deploy
```

Then add a Cloudflare Access application for `AUTH_HOST` that allows only you.

`wrangler.jsonc` vars: `PUBLIC_URL`, `AUTH_HOST`, `OWNER_EMAIL`, `IDENTITY_EMAIL_HEADER`, `IDENTITY_REQUIRE`, `CHANNEL_HISTORY_HOURS`, `DM_HISTORY_HOURS`, `THREAD_HISTORY_HOURS` (all 48 by default).

When the Slack session expires, `status.auth_error` is set. Sign in again with `bun run login` and re-put the two secrets (or POST them to `/v1/auth/session` with an OAuth token).

**Local:** `bun scripts/dev-vars.ts` writes `.dev.vars` from the session, then `bun run dev`. `bun scripts/local.ts` runs the same engine in Bun against `~/.slack-mirror/local.db`.

## How it stays current

- **Realtime:** `rtm.connect` gives a websocket URL, and the DO opens it with the `d` cookie (an outbound Workers websocket). Every frame goes to the append-only `events` table (kept 72h) and through `reduceEvent`, which handles messages, edits (old text goes to `message_edits`), deletes (tombstones), replies, reactions, files, joins/leaves/renames/archives, user changes, `*_marked` and `thread_*`. A ping is sent every 15s. If nothing arrives for 45s the socket counts as dead. Reconnects use exponential backoff capped at 60s and reset after a healthy session.
- **Reconcile:** this runs on every (re)connect and every 5 minutes:
  - `client.counts` overwrites the read state of every conversation and detects gaps.
  - `subscriptions.thread.getView` gives the exact `last_read` for every unread followed thread. A thread that drops out of the view was read elsewhere.
  - `conversations.history`/`replies` fill history. Guarantee: **every unread message is stored**. A conversation Slack marks unread is backfilled down to its `last_read` with no time cap, and an unread followed thread is fetched in full. Everything else gets 48h (`CHANNEL_HISTORY_HOURS`, `DM_HISTORY_HOURS`, `THREAD_HISTORY_HOURS`). `sync_state` keeps one contiguous range `[oldest_ts, newest_ts]` per conversation. Each pass extends the top to Slack's latest message, then the bottom down to the target, 10 pages of 200 messages at a time (unread conversations first), and resumes on the next pass. When `last_read` moves, the target moves with it.

  Gap detection compares Slack's `latest` against a per-conversation history watermark (`sync_state`), not `max(ts)`, so out-of-order inserts can't hide a gap.
- **Watchdog:** a DO alarm every 30s restarts the engine if the DO was evicted or redeployed. A gap is at most about 30s plus the reconnect time, and the next reconcile fills it.
- **History scope:** realtime-first. Backfill covers unread content plus the 48h windows; already-stored older messages are kept. Messages are never deleted, so the record grows from first boot on.

## Read state model

- `channel_reads(conversation_id, last_read, latest, has_unreads, unread_count_display, mention_count, source)` holds exactly what Slack reports (`source` records the last writer: `client.counts:*`, `channel_marked`, …).
- `thread_reads(conversation_id, thread_ts, subscribed, last_read, unread_count, source)` comes from `thread_marked` / `thread_subscribed` / `thread_unsubscribed`, `getView`, and parent messages' `last_read`/`subscribed`.
- A top-level message is unread when `ts > channel last_read`. A thread reply is unread when its thread is subscribed and `ts > thread last_read`. Own messages are always read.

## Schema

`describe_schema` (source in `src/api/queries.ts`) documents every table. Tables (`src/store/migrations.ts`): `workspaces`, `users`, `conversations`, `conversation_members`, `messages` (+ `messages_fts`, `message_edits`), `reactions`, `files`, `channel_reads`, `thread_reads`, `badges`, `events`, `sync_state`, `thread_sync`, `meta`. Raw Slack payloads are kept in `raw` columns.

## Code map

`src/slack/`: Effect Schemas, the API client (method allowlist, typed errors, retries), RTM websocket → Stream. `src/store/`: the SQLite repo shared by the DO and `bun:sqlite`. `src/ingest/`: `reduce.ts` (event → rows), `sync.ts` (bootstrap/reconcile/gap fill), `mirror.ts` (long-running engine). `src/api/`: `queries.ts` (the tools' SQL), `tools.ts` (registry), `mcp.ts`, `http.ts`. `src/cloudflare/`: `oauth.ts` (OAuth provider + consent page), `worker.ts` (MirrorDO), SQL adapter, crypto.

## Tests

`bun run check` runs the typecheck plus `bun test`: reducer, sync with a fake Slack API, every agent tool over HTTP and MCP, the SQL guard, the Slack write guard, and a realtime drop → reconnect → gap fill test with a fake websocket.

## Known limitations

- Member lists are stored for DMs/MPIMs/private channels Slack returns them for; large public channels may show no members.
- Replies to threads you don't follow that arrive while disconnected are only fetched when the parent's channel is gap-filled and the parent is in the window.
- Huddles, canvases, lists and Slack AI are stored only as raw events.
- Files: metadata only.
- One Slack workspace per deployment.
