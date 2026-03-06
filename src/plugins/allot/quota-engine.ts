/**
 * Allot Plugin — Core quota engine.
 *
 * Dual-layer sliding-window quota for remote connections:
 *   Layer 1: Rate limit (5-min window, auto-adaptive)
 *   Layer 2: Weekly limit (7-day window, manual + warnings)
 */

import type { AllotConfig, RemoteQuotaState, UsageRecord, ReserveResult } from './types.js'
import {
  RATE_WINDOW_MS,
  WEEKLY_WINDOW_MS,
  MAX_RATE_BUDGET,
  MIN_RATE_BUDGET,
} from './types.js'
import {
  getStore,
  updateConfig,
  updateRemote,
  addHistory,
  ensureRemote,
} from './allot-store.js'
import { getPairing } from '../../remote/pairing-store.js'
import { env } from '../../config/env.js'

const BOT_ID = env.BOT_TOKEN.slice(-6)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compose a remote ID key: BOT_ID:chatId[:threadId] (unique across all bots) */
export function remoteId(chatId: number, threadId: number | undefined): string {
  const base = threadId ? `${chatId}:${threadId}` : `${chatId}`
  return `${BOT_ID}:${base}`
}

/**
 * Count active remotes across ALL bots (from shared allot store).
 * A remote is "active" if it has pending reserves or recent rate-window usage.
 */
export function countConnectedRemotes(): number {
  const data = getStore().load()
  const cutoff = Date.now() - RATE_WINDOW_MS
  let count = 0
  for (const remote of Object.values(data.remotes)) {
    const hasRecent = remote.rateUsage.some((r) => r.timestamp >= cutoff)
    if (remote.pendingReserve > 0 || hasRecent) count++
  }
  return Math.max(1, count)
}

/** Sum turns consumed within a sliding window */
function sumTurnsInWindow(usage: readonly UsageRecord[], windowMs: number): number {
  const cutoff = Date.now() - windowMs
  let total = 0
  for (const r of usage) {
    if (r.timestamp >= cutoff) total += r.turns
  }
  return total
}

/**
 * Estimate ms until enough budget frees up in the window.
 * Walks oldest→newest, accumulating turns until we exceed `budget`.
 * The timestamp where that happens + windowMs = when it expires.
 */
function estimateRecoveryMs(
  usage: readonly UsageRecord[],
  windowMs: number,
  budget: number,
): number {
  const cutoff = Date.now() - windowMs
  const active = usage
    .filter((r) => r.timestamp >= cutoff)
    .sort((a, b) => a.timestamp - b.timestamp)

  let accumulated = 0
  for (const record of active) {
    accumulated += record.turns
    if (accumulated > budget) {
      const expiresAt = record.timestamp + windowMs
      return Math.max(0, expiresAt - Date.now())
    }
  }
  return 0
}

/** Format ms as "X 分 X 秒" */
function formatRecovery(ms: number): string {
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec} 秒`
  return sec > 0 ? `${min} 分 ${sec} 秒` : `${min} 分`
}

// ---------------------------------------------------------------------------
// Budget calculations
// ---------------------------------------------------------------------------

/** Per-remote rate budget (turns per 5-min window) — fixed per remote, not divided */
export function perRemoteRateBudget(config: AllotConfig): number {
  const ratio = (config.ratioPercent ?? 20) / 100
  const margin = 1 - config.marginPercent / 100
  return Math.max(1, Math.floor(config.rateBudget * ratio * margin))
}

/** Per-remote weekly budget (turns per week) — fixed per remote, not divided */
export function perRemoteWeeklyBudget(config: AllotConfig): number {
  const ratio = (config.ratioPercent ?? 20) / 100
  const margin = 1 - config.marginPercent / 100
  return Math.max(1, Math.floor(config.weeklyBudget * ratio * margin))
}

/** Weekly usage percentage for a remote */
export function weeklyUsagePercent(
  remote: RemoteQuotaState,
  config: AllotConfig,
): number {
  const used = sumTurnsInWindow(remote.weeklyUsage, WEEKLY_WINDOW_MS)
  const budget = perRemoteWeeklyBudget(config)
  return budget > 0 ? (used / budget) * 100 : 0
}

/** Rate usage for a remote (turns used in current 5-min window) */
export function rateUsedTurns(remote: RemoteQuotaState): number {
  return sumTurnsInWindow(remote.rateUsage, RATE_WINDOW_MS)
}

/** Weekly usage for a remote (turns used in current 7-day window) */
export function weeklyUsedTurns(remote: RemoteQuotaState): number {
  return sumTurnsInWindow(remote.weeklyUsage, WEEKLY_WINDOW_MS)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pre-reserve turns before enqueue.
 * Returns { allowed: true } or { allowed: false, reason: '...' }
 */
export function tryReserve(
  chatId: number,
  threadId: number | undefined,
): ReserveResult {
  const data = getStore().load()
  if (!data.config.enabled) return { allowed: true }

  const id = remoteId(chatId, threadId)
  const pairing = getPairing(chatId, threadId)
  const label = pairing?.label ?? 'unknown'
  const remote = ensureRemote(id, label)
  const config = data.config
  const reserve = config.reserveAmount

  // Layer 1: Rate limit check
  const rateUsed = sumTurnsInWindow(remote.rateUsage, RATE_WINDOW_MS) + remote.pendingReserve
  const rateBudget = perRemoteRateBudget(config)

  if (rateUsed + reserve > rateBudget) {
    const recoveryMs = estimateRecoveryMs(remote.rateUsage, RATE_WINDOW_MS, rateBudget)
    const reason = `\u{23F3} 額度已用完，預計 ${formatRecovery(recoveryMs)} 後恢復，請稍後再試`
    addHistory({ type: 'reject', remoteId: id, detail: `rate: ${rateUsed}/${rateBudget}` })
    return { allowed: false, reason }
  }

  // Layer 2: Weekly limit check
  const weeklyUsed = sumTurnsInWindow(remote.weeklyUsage, WEEKLY_WINDOW_MS) + remote.pendingReserve
  const weekBudget = perRemoteWeeklyBudget(config)

  if (weeklyUsed + reserve > weekBudget) {
    const recoveryMs = estimateRecoveryMs(remote.weeklyUsage, WEEKLY_WINDOW_MS, weekBudget)
    const reason = `\u{23F3} 本週額度已用完，預計 ${formatRecovery(recoveryMs)} 後恢復，請稍後再試`
    addHistory({ type: 'reject', remoteId: id, detail: `weekly: ${weeklyUsed}/${weekBudget}` })
    return { allowed: false, reason }
  }

  // Reserve turns
  updateRemote(id, (r) => ({
    ...r,
    pendingReserve: r.pendingReserve + reserve,
  }))
  addHistory({ type: 'reserve', remoteId: id, detail: `+${reserve}` })

  // Check weekly warning thresholds
  const pctAfter = ((weeklyUsed + reserve) / weekBudget) * 100
  let warningLevel: 70 | 85 | 95 | undefined
  if (pctAfter >= 95) warningLevel = 95
  else if (pctAfter >= 85) warningLevel = 85
  else if (pctAfter >= 70) warningLevel = 70

  return { allowed: true, warningLevel }
}

/**
 * Settle actual usage after request completion.
 * Releases the pre-reserve and records actual turn count.
 */
export function settle(
  chatId: number,
  threadId: number | undefined,
  actualTurns: number,
): void {
  const data = getStore().load()
  if (!data.config.enabled) return

  const id = remoteId(chatId, threadId)
  if (!data.remotes[id]) return

  const config = data.config
  const now = Date.now()
  const record: UsageRecord = { timestamp: now, turns: actualTurns }

  updateRemote(id, (r) => ({
    ...r,
    pendingReserve: Math.max(0, r.pendingReserve - config.reserveAmount),
    rateUsage: [...r.rateUsage, record],
    weeklyUsage: [...r.weeklyUsage, record],
  }))
  addHistory({ type: 'settle', remoteId: id, detail: `actual=${actualTurns}` })
}

/**
 * Called when a 429 error is detected.
 * Auto-mode: decrease rate budget by 10 (min MIN_RATE_BUDGET).
 */
export function on429Detected(): void {
  const data = getStore().load()
  if (data.config.mode !== 'auto') return

  const prev = data.config.rateBudget
  const next = Math.max(MIN_RATE_BUDGET, prev - 10)
  updateConfig({
    rateBudget: next,
    consecutiveClean: 0,
    last429At: Date.now(),
  })
  addHistory({ type: '429', remoteId: 'system', detail: `budget: ${prev} -> ${next}` })
}

/**
 * Periodic adaptive tick (called by service timer every 5 min).
 * If no 429 in the last rate window, increase budget by +2.
 */
export function adaptiveTick(): void {
  const data = getStore().load()
  if (data.config.mode !== 'auto') return

  const now = Date.now()
  const last429 = data.config.last429At

  // Only increase if no 429 in the last full rate window
  if (last429 && now - last429 < RATE_WINDOW_MS) return

  const prev = data.config.rateBudget
  const next = Math.min(MAX_RATE_BUDGET, prev + 2)
  if (next === prev) return // already at max

  updateConfig({
    rateBudget: next,
    consecutiveClean: data.config.consecutiveClean + 1,
  })
  addHistory({ type: 'adjust', remoteId: 'system', detail: `+2 -> ${next}` })
}

/** Prune expired records from all remote windows */
export function pruneExpiredRecords(): void {
  const data = getStore().load()
  const now = Date.now()

  for (const id of Object.keys(data.remotes)) {
    updateRemote(id, (r) => ({
      ...r,
      rateUsage: r.rateUsage.filter((u) => now - u.timestamp < RATE_WINDOW_MS),
      weeklyUsage: r.weeklyUsage.filter((u) => now - u.timestamp < WEEKLY_WINDOW_MS),
    }))
  }
}
