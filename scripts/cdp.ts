/** Tiny Chrome DevTools Protocol client (no dependencies). */
export class Cdp {
  private id = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data))
      const p = msg.id != null ? this.pending.get(msg.id) : undefined
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    })
  }
  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve())
      ws.addEventListener("error", () => reject(new Error(`CDP connect failed: ${wsUrl}`)))
    })
    return new Cdp(ws)
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.id
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  close() {
    this.ws.close()
  }
}
