import { Context, Data, Duration, Effect, Layer, Schedule, Schema } from "effect"
import * as S from "./schema.ts"

export type SlackCredentials =
  /** Web-client session: xoxc token + `d` cookie (what app.slack.com uses). */
  | { readonly kind: "session"; readonly token: string; readonly cookie: string }
  /** Documented user OAuth token. No RTM, no thread read state. */
  | { readonly kind: "oauth"; readonly token: string }

export class SlackApiError extends Data.TaggedError("SlackApiError")<{
  readonly method: string
  readonly error: string
}> {}
export class SlackAuthError extends Data.TaggedError("SlackAuthError")<{ readonly method: string; readonly error: string }> {}
export class SlackRateLimited extends Data.TaggedError("SlackRateLimited")<{ readonly method: string; readonly retryAfterMs: number }> {}
export class SlackHttpError extends Data.TaggedError("SlackHttpError")<{ readonly method: string; readonly status: number; readonly cause?: unknown }> {}
export class SlackDecodeError extends Data.TaggedError("SlackDecodeError")<{ readonly method: string; readonly message: string }> {}
export class SlackWriteForbidden extends Data.TaggedError("SlackWriteForbidden")<{ readonly method: string }> {}
export class NotSignedIn extends Data.TaggedError("NotSignedIn")<{}> {}

export type SlackError = SlackApiError | SlackAuthError | SlackRateLimited | SlackHttpError | SlackDecodeError | SlackWriteForbidden | NotSignedIn

/**
 * Every Slack method this program may call. Anything not listed is refused
 * before a request is made. All are read-only except MARK_METHODS, which are
 * additionally gated by `allowMarkRead`.
 */
export const READ_METHODS = new Set([
  "auth.test", "client.counts", "client.userBoot", "conversations.history", "conversations.info",
  "conversations.members", "conversations.replies", "rtm.connect", "subscriptions.thread.getView",
  "team.info", "users.conversations", "users.info", "users.list", "users.prefs.get",
])
export const MARK_METHODS = new Set(["conversations.mark", "subscriptions.thread.mark"])

const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"])

export interface SlackApiConfig {
  /** e.g. https://acme.slack.com/api/ */
  readonly apiBase: string
  readonly allowMarkRead: boolean
  readonly onSample?: (method: string, body: unknown) => void
}

export const sessionHeaders = (creds: SlackCredentials): Record<string, string> =>
  creds.kind === "session"
    ? { cookie: `d=${encodeURIComponent(creds.cookie)}`, origin: "https://app.slack.com" }
    : {}

export interface SlackApiService {
  readonly credentials: SlackCredentials
  readonly call: <A, I>(
    method: string,
    schema: Schema.Schema<A, I>,
    params?: Record<string, string | number | boolean | undefined>,
  ) => Effect.Effect<A, SlackError>
}

export class SlackApi extends Context.Tag("slack-mirror/SlackApi")<SlackApi, SlackApiService>() {}

export const makeSlackApi = (creds: SlackCredentials, config: SlackApiConfig): SlackApiService => {
  const once = <A, I>(method: string, schema: Schema.Schema<A, I>, params: Record<string, string | number | boolean | undefined>) =>
    Effect.gen(function* () {
      if (!READ_METHODS.has(method) && !MARK_METHODS.has(method)) return yield* new SlackWriteForbidden({ method })
      if (MARK_METHODS.has(method) && !config.allowMarkRead) return yield* new SlackWriteForbidden({ method })
      const body = new URLSearchParams({ token: creds.token })
      for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v))
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(`${config.apiBase}${method}`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", ...sessionHeaders(creds) },
            body,
          }),
        catch: (cause) => new SlackHttpError({ method, status: 0, cause }),
      })
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after") ?? "30")
        return yield* new SlackRateLimited({ method, retryAfterMs: retry * 1000 })
      }
      if (!res.ok) return yield* new SlackHttpError({ method, status: res.status })
      const json = yield* Effect.tryPromise({
        try: () => res.json() as Promise<{ ok?: boolean; error?: string }>,
        catch: (cause) => new SlackHttpError({ method, status: res.status, cause }),
      })
      if (json.ok !== true) {
        const error = json.error ?? "unknown_error"
        if (error === "ratelimited") return yield* new SlackRateLimited({ method, retryAfterMs: 30_000 })
        if (AUTH_ERRORS.has(error)) return yield* new SlackAuthError({ method, error })
        return yield* new SlackApiError({ method, error })
      }
      config.onSample?.(method, json)
      return yield* Schema.decodeUnknown(schema)(json).pipe(
        Effect.mapError((e) => new SlackDecodeError({ method, message: e.message })),
      )
    })

  return {
    credentials: creds,
    call: (method, schema, params = {}) =>
      once(method, schema, params).pipe(
        // Short in-request retries for transient HTTP failures and brief rate limits;
        // longer rate limits surface to the caller which reschedules work.
        Effect.retry({
          schedule: Schedule.exponential(Duration.millis(500)).pipe(Schedule.compose(Schedule.recurs(3))),
          while: (e) => (e._tag === "SlackHttpError" && (e.status === 0 || e.status >= 500)) || (e._tag === "SlackRateLimited" && e.retryAfterMs <= 5_000),
        }),
        Effect.withSpan(`slack.${method}`),
      ),
  }
}

export const SlackApiLive = (creds: SlackCredentials, config: SlackApiConfig) => Layer.succeed(SlackApi, makeSlackApi(creds, config))

/* ------------- typed helpers ------------- */

export const Ok = Schema.Struct({ ok: Schema.Literal(true) })

export const authTest = SlackApi.pipe(Effect.flatMap((api) => api.call("auth.test", S.AuthTest)))
export const clientCounts = SlackApi.pipe(
  Effect.flatMap((api) =>
    api.call("client.counts", S.ClientCounts, { thread_counts_by_channel: true, org_wide_aware: true, include_file_channels: true }),
  ),
)
export const userBoot = SlackApi.pipe(
  Effect.flatMap((api) =>
    api.call("client.userBoot", S.UserBoot, { _x_reason: "slack-mirror-boot", min_channel_updated: 0, version_ts: 0, build_version_ts: 0 }),
  ),
)
export const threadView = (limit = 50, maxTs?: string) =>
  SlackApi.pipe(Effect.flatMap((api) => api.call("subscriptions.thread.getView", S.ThreadView, { limit, max_ts: maxTs })))
export const history = (channel: string, p: { oldest?: string | undefined; latest?: string | undefined; cursor?: string | undefined; limit?: number; inclusive?: boolean }) =>
  SlackApi.pipe(Effect.flatMap((api) => api.call("conversations.history", S.HistoryPage, { channel, limit: p.limit ?? 200, oldest: p.oldest, latest: p.latest, cursor: p.cursor, inclusive: p.inclusive ?? false })))
export const replies = (channel: string, ts: string, p: { oldest?: string | undefined; cursor?: string | undefined }) =>
  SlackApi.pipe(Effect.flatMap((api) => api.call("conversations.replies", S.HistoryPage, { channel, ts, limit: 200, oldest: p.oldest, cursor: p.cursor })))
export const conversationInfo = (channel: string) =>
  SlackApi.pipe(Effect.flatMap((api) => api.call("conversations.info", S.ConversationInfo, { channel })))
export const usersConversations = (cursor?: string) =>
  SlackApi.pipe(Effect.flatMap((api) => api.call("users.conversations", S.ConversationsPage, { types: "public_channel,private_channel,mpim,im", exclude_archived: true, limit: 200, cursor })))
export const conversationMembers = (channel: string, cursor?: string) =>
  SlackApi.pipe(Effect.flatMap((api) => api.call("conversations.members", S.MembersPage, { channel, limit: 1000, cursor })))
export const usersList = (cursor?: string) =>
  SlackApi.pipe(Effect.flatMap((api) => api.call("users.list", S.UsersPage, { limit: 500, cursor })))
export const userInfo = (user: string) => SlackApi.pipe(Effect.flatMap((api) => api.call("users.info", S.UserInfo, { user })))
export const rtmConnect = SlackApi.pipe(Effect.flatMap((api) => api.call("rtm.connect", S.RtmConnect, { batch_presence_aware: 1 })))

/** The only two mutations: move the owner's own read cursor (explicitly enabled). */
export const markConversation = (channel: string, ts: string) =>
  SlackApi.pipe(Effect.flatMap((api) => api.call("conversations.mark", Ok, { channel, ts })))
export const markThread = (channel: string, threadTs: string, ts: string) =>
  SlackApi.pipe(Effect.flatMap((api) => api.call("subscriptions.thread.mark", Ok, { channel, thread_ts: threadTs, ts, read: 1 })))
