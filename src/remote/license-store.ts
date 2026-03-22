/**
 * License Store — manages license keys for Electron desktop clients.
 *
 * Each license has a plan (basic/plus/pro) with different quota limits.
 * Multiple devices sharing the same license key share the same usage pool.
 *
 * Storage: data/licenses.json via createJsonFileStore, shared across
 * all bot instances via mainRepoPath().
 */

import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createJsonFileStore, type JsonFileStore } from '../utils/json-file-store.js'
import { mainRepoPath } from '../git/worktree.js'

// --- Types ---

export type LicensePlan = 'basic' | 'plus' | 'pro'

export interface UsageRecord {
  readonly timestamp: number
  readonly turns: number
}

export interface License {
  readonly key: string
  readonly plan: LicensePlan
  readonly createdAt: number
  readonly expiresAt: number
  readonly revoked: boolean
  readonly label: string
  readonly rateUsage: readonly UsageRecord[]
  readonly weeklyUsage: readonly UsageRecord[]
  readonly pendingReserve: number
}

interface LicenseStore {
  readonly licenses: Record<string, License>
}

// --- Plan limits ---

export const PLAN_LIMITS: Record<LicensePlan, { readonly rateBudget: number; readonly weeklyBudget: number }> = {
  basic: { rateBudget: 3, weeklyBudget: 50 },
  plus:  { rateBudget: 5, weeklyBudget: 100 },
  pro:   { rateBudget: 10, weeklyBudget: 200 },
}

const RATE_WINDOW_MS = 5 * 60 * 1000
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_DURATION_DAYS = 30
const RESERVE_AMOUNT = 3

// --- Store singleton ---

const mainRoot = mainRepoPath(process.cwd()) ?? process.cwd()
const DATA_PATH = join(mainRoot, 'data', 'licenses.json')

let store: JsonFileStore<LicenseStore> | null = null

function getStore(): JsonFileStore<LicenseStore> {
  if (!store) {
    store = createJsonFileStore<LicenseStore>(DATA_PATH, () => ({ licenses: {} }))
  }
  return store
}

// --- Key generation ---

function generateKey(): string {
  const hex = randomBytes(6).toString('hex').toUpperCase()
  return `CB-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`
}

// --- CRUD ---

export function createLicense(plan: LicensePlan, label: string, durationDays = DEFAULT_DURATION_DAYS): License {
  const s = getStore()
  const data = s.load()
  const now = Date.now()
  const key = generateKey()

  const license: License = {
    key,
    plan,
    createdAt: now,
    expiresAt: now + durationDays * 24 * 60 * 60 * 1000,
    revoked: false,
    label,
    rateUsage: [],
    weeklyUsage: [],
    pendingReserve: 0,
  }

  s.save({ licenses: { ...data.licenses, [key]: license } })
  return license
}

export function getLicense(key: string): License | null {
  return getStore().load().licenses[key] ?? null
}

export function listLicenses(): readonly License[] {
  return Object.values(getStore().load().licenses)
}

export function revokeLicense(key: string): boolean {
  const s = getStore()
  const data = s.load()
  const license = data.licenses[key]
  if (!license) return false
  s.save({
    licenses: { ...data.licenses, [key]: { ...license, revoked: true } },
  })
  return true
}

export function renewLicense(key: string, durationDays = DEFAULT_DURATION_DAYS): boolean {
  const s = getStore()
  const data = s.load()
  const license = data.licenses[key]
  if (!license) return false

  const base = Math.max(license.expiresAt, Date.now())
  s.save({
    licenses: {
      ...data.licenses,
      [key]: { ...license, expiresAt: base + durationDays * 24 * 60 * 60 * 1000, revoked: false },
    },
  })
  return true
}

// --- Validation ---

export interface ValidateResult {
  readonly valid: boolean
  readonly reason?: string
  readonly license?: License
}

export function validateLicense(key: string): ValidateResult {
  const license = getLicense(key)
  if (!license) return { valid: false, reason: '序號不存在' }
  if (license.revoked) return { valid: false, reason: '序號已停用' }
  if (Date.now() > license.expiresAt) return { valid: false, reason: '序號已過期' }
  return { valid: true, license }
}

// --- Quota ---

function pruneWindow(records: readonly UsageRecord[], windowMs: number, now: number): readonly UsageRecord[] {
  const cutoff = now - windowMs
  return records.filter((r) => r.timestamp > cutoff)
}

function sumTurns(records: readonly UsageRecord[]): number {
  let total = 0
  for (const r of records) total += r.turns
  return total
}

export interface ReserveResult {
  readonly allowed: boolean
  readonly reason?: string
}

export function tryReserveLicense(key: string): ReserveResult {
  const s = getStore()
  const data = s.load()
  const license = data.licenses[key]
  if (!license) return { allowed: false, reason: '序號不存在' }

  const validation = validateLicense(key)
  if (!validation.valid) return { allowed: false, reason: validation.reason }

  const now = Date.now()
  const limits = PLAN_LIMITS[license.plan]

  // Rate limit check (5-min sliding window)
  const rateRecords = pruneWindow(license.rateUsage, RATE_WINDOW_MS, now)
  const rateUsed = sumTurns(rateRecords) + license.pendingReserve
  if (rateUsed >= limits.rateBudget) {
    return { allowed: false, reason: '⏳ 短期額度已滿，請稍後再試' }
  }

  // Weekly budget check
  const weeklyRecords = pruneWindow(license.weeklyUsage, WEEKLY_WINDOW_MS, now)
  const weeklyUsed = sumTurns(weeklyRecords) + license.pendingReserve
  if (weeklyUsed >= limits.weeklyBudget) {
    return { allowed: false, reason: '⏳ 本週額度已用完' }
  }

  // Reserve
  s.save({
    licenses: {
      ...data.licenses,
      [key]: {
        ...license,
        rateUsage: rateRecords,
        weeklyUsage: weeklyRecords,
        pendingReserve: license.pendingReserve + RESERVE_AMOUNT,
      },
    },
  })

  return { allowed: true }
}

export function settleLicense(key: string, turns: number): void {
  const s = getStore()
  const data = s.load()
  const license = data.licenses[key]
  if (!license) return

  const now = Date.now()
  const record: UsageRecord = { timestamp: now, turns }

  s.save({
    licenses: {
      ...data.licenses,
      [key]: {
        ...license,
        rateUsage: [...pruneWindow(license.rateUsage, RATE_WINDOW_MS, now), record],
        weeklyUsage: [...pruneWindow(license.weeklyUsage, WEEKLY_WINDOW_MS, now), record],
        pendingReserve: Math.max(0, license.pendingReserve - RESERVE_AMOUNT),
      },
    },
  })
}
