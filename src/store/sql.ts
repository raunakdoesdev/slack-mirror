import { Context } from "effect"

export type SqlValue = string | number | null | ArrayBuffer
export type Row = Record<string, SqlValue>

/**
 * Minimal synchronous SQLite surface shared by Durable Object storage
 * (`ctx.storage.sql`) and `bun:sqlite` (tests, local tools).
 */
export interface Sql {
  readonly all: <T = Row>(query: string, ...params: ReadonlyArray<unknown>) => T[]
  readonly run: (query: string, ...params: ReadonlyArray<unknown>) => number
  /** Executes a multi-statement script without bindings (migrations). */
  readonly script: (query: string) => void
  readonly transaction: <A>(f: () => A) => A
}

export class SqlDb extends Context.Tag("slack-mirror/SqlDb")<SqlDb, Sql>() {}

export const bind = (params: ReadonlyArray<unknown>): SqlValue[] =>
  params.map((p) => {
    if (p === undefined || p === null) return null
    if (typeof p === "boolean") return p ? 1 : 0
    if (typeof p === "string" || typeof p === "number") return p
    if (p instanceof ArrayBuffer) return p
    return JSON.stringify(p)
  })

export const first = <T>(rows: T[]): T | undefined => rows[0]
