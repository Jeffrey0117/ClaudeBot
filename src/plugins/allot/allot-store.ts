/**
 * Allot Plugin — Persistent storage layer.
 * Uses atomic JSON file store at data/allot.json.
 */

import { resolve, join } from 'node:path'
import { createJsonFileStore, type JsonFileStore } from '../../utils/json-file-store.js'
import type {
  AllotStore,
  AllotConfig,
  RemoteQuotaState,
  HistoryEntry,
} from './types.js'
import { DEFAULT_CONFIG, MAX_HISTORY } from './types.js'
import { mainRepoPath } from '../../git/worktree.js'

// Shared across all bot instances: always write to main repo's data/allot.json
const mainRoot = mainRepoPath(process.cwd()) ?? process.cwd()
const DATA_PATH = join(mainRoot, 'data', 'allot.json')

let store: JsonFileStore<AllotStore> | null = null

function makeDefault(): AllotStore {
  return {
    config: DEFAULT_CONFIG,
    remotes: {},
    history: [],
  }
}

export function getStore(): JsonFileStore<AllotStore> {
  if (!store) {
    store = createJsonFileStore<AllotStore>(DATA_PATH, makeDefault)
  }
  return store
}

/** Immutably update config fields */
export function updateConfig(patch: Partial<AllotConfig>): AllotConfig {
  const s = getStore()
  const data = s.load()
  const updated: AllotConfig = { ...data.config, ...patch }
  s.save({ ...data, config: updated })
  return updated
}

/** Immutably update a specific remote's state */
export function updateRemote(
  id: string,
  updater: (r: RemoteQuotaState) => RemoteQuotaState,
): void {
  const s = getStore()
  const data = s.load()
  const existing = data.remotes[id]
  if (!existing) return
  const updated = updater(existing)
  s.save({
    ...data,
    remotes: { ...data.remotes, [id]: updated },
  })
}

/** Ensure a remote entry exists, creating if needed */
export function ensureRemote(id: string, label: string): RemoteQuotaState {
  const s = getStore()
  const data = s.load()
  const existing = data.remotes[id]
  if (existing) {
    // Update label if changed
    if (existing.label !== label) {
      const updated = { ...existing, label }
      s.save({ ...data, remotes: { ...data.remotes, [id]: updated } })
      return updated
    }
    return existing
  }
  const fresh: RemoteQuotaState = {
    id,
    label,
    rateUsage: [],
    weeklyUsage: [],
    pendingReserve: 0,
  }
  s.save({ ...data, remotes: { ...data.remotes, [id]: fresh } })
  return fresh
}

/** Get a remote's state (or null if not tracked) */
export function getRemoteState(id: string): RemoteQuotaState | null {
  return getStore().load().remotes[id] ?? null
}

/** Reset a specific remote's usage records */
export function resetRemoteUsage(id: string): void {
  updateRemote(id, (r) => ({
    ...r,
    rateUsage: [],
    weeklyUsage: [],
    pendingReserve: 0,
  }))
}

/** Append a history entry (capped at MAX_HISTORY) */
export function addHistory(
  entry: Omit<HistoryEntry, 'timestamp'>,
): void {
  const s = getStore()
  const data = s.load()
  const full: HistoryEntry = { ...entry, timestamp: Date.now() }
  const updated = [...data.history, full]
  const trimmed = updated.length > MAX_HISTORY
    ? updated.slice(updated.length - MAX_HISTORY)
    : updated
  s.save({ ...data, history: trimmed })
}
