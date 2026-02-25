/**
 * In-memory ASR mode state per chat.
 * 'next' = one-shot (resets after one voice message)
 * 'on'   = continuous (auto-expires after 5 min)
 * 'off'  = normal voice handling (send to AI)
 */

export type AsrMode = 'off' | 'next' | 'on'

interface AsrState {
  mode: AsrMode
  timer: ReturnType<typeof setTimeout> | null
}

const states = new Map<number, AsrState>()

const AUTO_OFF_MS = 5 * 60 * 1000

export function getAsrMode(chatId: number): AsrMode {
  return states.get(chatId)?.mode ?? 'off'
}

export function setAsrMode(chatId: number, mode: AsrMode): void {
  const existing = states.get(chatId)
  if (existing?.timer) clearTimeout(existing.timer)

  if (mode === 'off') {
    states.delete(chatId)
    return
  }

  const timer = mode === 'on'
    ? setTimeout(() => { states.delete(chatId) }, AUTO_OFF_MS)
    : null

  states.set(chatId, { mode, timer })
}

/** Called after a voice message is processed in ASR mode. Resets 'next' to 'off'. */
export function consumeAsrMode(chatId: number): void {
  const state = states.get(chatId)
  if (!state) return

  if (state.mode === 'next') {
    if (state.timer) clearTimeout(state.timer)
    states.delete(chatId)
  }
  // 'on' mode stays active
}
