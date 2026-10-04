import { Effect, Layer, Schema } from "effect"
import { SlackApi, SlackApiError, SlackDecodeError, type SlackApiService } from "../src/slack/api.ts"
import { migrate } from "../src/store/migrations.ts"
import { makeRepo, Store } from "../src/store/store.ts"
import { bunSql } from "../scripts/bun-sql.ts"
import * as F from "./fixtures/rtm.ts"

export const newRepo = () => {
  const sql = bunSql()
  migrate(sql)
  const repo = makeRepo(sql)
  repo.setIdentity({ selfUserId: F.SELF, teamId: "T0", groupIds: ["S0ENG"] }, { name: "Acme" })
  repo.upsertConversation({ id: F.C, name: "general", is_channel: true })
  return repo
}

export type Handler = (params: Record<string, unknown>) => unknown

/** Fake Slack Web API: responses still go through the real Effect schemas. */
export const fakeSlack = (handlers: Record<string, Handler>, calls: Array<{ method: string; params: Record<string, unknown> }> = []): SlackApiService => ({
  credentials: { kind: "session", token: "xoxc-test", cookie: "xoxd-test" },
  call: (method, schema, params = {}) =>
    Effect.gen(function* () {
      calls.push({ method, params })
      const h = handlers[method]
      if (!h) return yield* new SlackApiError({ method, error: "not_mocked" })
      const body = h(params) as { ok?: boolean; error?: string }
      if (body.ok === false) return yield* new SlackApiError({ method, error: body.error ?? "err" })
      return yield* Schema.decodeUnknown(schema)(body).pipe(Effect.mapError((e) => new SlackDecodeError({ method, message: e.message })))
    }),
})

export const layerFor = (repo: ReturnType<typeof makeRepo>, slack: SlackApiService) =>
  Layer.merge(Layer.succeed(Store, repo), Layer.succeed(SlackApi, slack))

export const nowTs = (offsetSec = 0) => (Date.now() / 1000 + offsetSec).toFixed(6)
