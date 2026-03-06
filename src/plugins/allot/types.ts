/**
 * Allot Plugin — Type definitions for remote quota management.
 */

/** A single usage record in a sliding window */
export interface UsageRecord {
  readonly timestamp: number
  readonly turns: number // actual turns consumed (toolCount + 1)
}

/** Per-remote connection quota state */
export interface RemoteQuotaState {
  readonly id: string // "chatId" or "chatId:threadId"
  readonly label: string // PairingSession.label
  readonly rateUsage: readonly UsageRecord[] // 5-min sliding window
  readonly weeklyUsage: readonly UsageRecord[] // 7-day sliding window
  readonly pendingReserve: number // pre-reserved turns awaiting settle
}

/** Plugin configuration */
export interface AllotConfig {
  readonly enabled: boolean
  readonly mode: 'auto' | 'manual'
  readonly rateBudget: number // turns per 5-min window (start: 10)
  readonly weeklyBudget: number // turns per week (start: 1500)
  readonly ratioPercent: number // % of budget each remote gets (fixed per remote, default: 20)
  readonly marginPercent: number // safety margin 0-50 (default: 10)
  readonly reserveAmount: number // turns to pre-reserve per request (default: 3)
  readonly consecutiveClean: number // consecutive clean windows (no 429)
  readonly last429At: number | null // timestamp of last 429 detection
}

/** Full persistent store */
export interface AllotStore {
  readonly config: AllotConfig
  readonly remotes: Record<string, RemoteQuotaState>
  readonly history: readonly HistoryEntry[]
}

/** Audit log entry */
export interface HistoryEntry {
  readonly timestamp: number
  readonly type: 'reserve' | 'settle' | 'reject' | 'warn' | '429' | 'adjust'
  readonly remoteId: string
  readonly detail: string
}

/** Result from tryReserve check */
export interface ReserveResult {
  readonly allowed: boolean
  readonly reason?: string // rejection message (Chinese)
  readonly warningLevel?: 70 | 85 | 95 // weekly threshold crossed
}

/** Default config values */
export const DEFAULT_CONFIG: AllotConfig = {
  enabled: false,
  mode: 'auto',
  rateBudget: 10,
  weeklyBudget: 1500,
  ratioPercent: 20,
  marginPercent: 10,
  reserveAmount: 3,
  consecutiveClean: 0,
  last429At: null,
} as const

export const RATE_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
export const MAX_HISTORY = 100
export const MAX_RATE_BUDGET = 100
export const MIN_RATE_BUDGET = 5
