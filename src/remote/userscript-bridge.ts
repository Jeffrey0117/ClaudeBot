/**
 * Userscript bridge — in-memory command queue between the bot and a Tampermonkey
 * userscript running in the (remote) browser. The bot pushes JS to run; the
 * userscript polls, evals it in the page, and posts the result back. This is the
 * precise, DOM-level "JS agent" path (vs telling the model to fumble a browser).
 *
 * Transport: the relay's public HTTP endpoints (/us/poll, /us/result), so it
 * works from a remote browser through the existing tunnel. Auth: shared token.
 */

interface UsCommand {
  readonly id: number
  readonly js: string
}

let nextId = 1
const pending: UsCommand[] = []
const waiting = new Map<number, { resolve: (r: { result?: string; error?: string }) => void; timer: ReturnType<typeof setTimeout> }>()

/** Queue JS for the userscript to run; resolves with its result (or a timeout). */
export function pushUserscriptCommand(js: string, timeoutMs = 20_000): Promise<{ result?: string; error?: string }> {
  const id = nextId++
  pending.push({ id, js })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      resolve({ error: 'userscript 沒回應（確認那台瀏覽器有裝並啟用橋接腳本、且 RELAY/TOKEN 設對）' })
    }, timeoutMs)
    waiting.set(id, { resolve, timer })
  })
}

/** Poll: hand the userscript all queued commands (and clear the queue). */
export function takePendingCommands(): readonly UsCommand[] {
  return pending.splice(0, pending.length)
}

/** Result callback from the userscript. */
export function submitUserscriptResult(id: number, result?: string, error?: string): void {
  const w = waiting.get(id)
  if (!w) return
  clearTimeout(w.timer)
  waiting.delete(id)
  w.resolve({ result, error })
}
