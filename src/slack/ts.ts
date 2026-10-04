/** Slack message timestamps are fixed-width "seconds.micros" strings. */
export const tsGt = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a != null && (b == null || a > b)

export const tsMax = (a: string | null | undefined, b: string | null | undefined): string | null =>
  a == null ? (b ?? null) : b == null ? a : a > b ? a : b

export const tsToMillis = (ts: string): number => Math.floor(Number(ts) * 1000)

export const millisToTs = (ms: number): string => (ms / 1000).toFixed(6)

/** Slack uses "0000000000.000000" for "never read". */
export const ZERO_TS = "0000000000.000000"
