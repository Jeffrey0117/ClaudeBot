/**
 * In-memory pairing state for remote vibe-coding sessions.
 * Ephemeral by design — pairings don't survive bot restart
 * (the WebSocket connection would be dead anyway).
 */

import { sessionKey } from '../bot/state.js'

export interface PairingSession {
  readonly wsUrl: string
  readonly code: string
  readonly connectedAt: number
  readonly label: string
}

const pairings = new Map<string, PairingSession>()

export function setPairing(
  chatId: number,
  threadId: number | undefined,
  session: PairingSession,
): void {
  pairings.set(sessionKey(chatId, threadId), session)
}

export function getPairing(
  chatId: number,
  threadId: number | undefined,
): PairingSession | null {
  return pairings.get(sessionKey(chatId, threadId)) ?? null
}

export function removePairing(
  chatId: number,
  threadId: number | undefined,
): boolean {
  return pairings.delete(sessionKey(chatId, threadId))
}
