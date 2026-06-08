export type CdpEventHandler = (params: unknown) => void

/** Routes CDP events (method/params messages with no id) to subscribers. */
export class CdpEventRouter {
  private readonly listeners = new Map<string, Set<CdpEventHandler>>()

  on(method: string, handler: CdpEventHandler): void {
    const set = this.listeners.get(method) ?? new Set<CdpEventHandler>()
    set.add(handler)
    this.listeners.set(method, set)
  }

  off(method: string, handler: CdpEventHandler): void {
    this.listeners.get(method)?.delete(handler)
  }

  dispatch(method: string, params: unknown): void {
    const set = this.listeners.get(method)
    if (!set) return
    for (const h of set) {
      try { h(params) } catch { /* one bad handler must not break the rest */ }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
