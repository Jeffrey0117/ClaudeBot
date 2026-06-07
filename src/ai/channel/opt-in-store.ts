import { resolve } from 'node:path'
import { createJsonFileStore } from '../../utils/json-file-store.js'
import { isRemotePath } from '../../remote/pairing-store.js'

// path → explicit override. Absent = default (ON for local projects).
// An explicit `false` (set via /channel off) disables it for that project.
type ChannelData = Record<string, boolean>

let store = createJsonFileStore<ChannelData>(resolve('data/channel-opt-in.json'), () => ({}))

/** Test-only: drop the cached store so a deleted file is re-read. */
export function __resetForTest(): void {
  store = createJsonFileStore<ChannelData>(resolve('data/channel-opt-in.json'), () => ({}))
}

/**
 * Channel is ON by default for LOCAL projects (Phase 1). Remote projects are
 * never channel-routed — their path (`remote:label`) is not a real cwd and the
 * remote_* MCP tools aren't wired into the persistent session yet (that's
 * Phase 2b). An explicit `false` override disables it for a specific project.
 */
export function isChannelEnabled(projectPath: string): boolean {
  if (isRemotePath(projectPath)) return false
  return store.load()[projectPath] !== false
}

/** /channel on → clear override (back to default-on). /channel off → explicit off. */
export function setChannelEnabled(projectPath: string, on: boolean): void {
  const data = { ...store.load() }
  if (on) delete data[projectPath]
  else data[projectPath] = false
  store.save(data)
}
