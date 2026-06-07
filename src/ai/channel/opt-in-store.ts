import { resolve } from 'node:path'
import { createJsonFileStore } from '../../utils/json-file-store.js'
import { isRemotePath } from '../../remote/pairing-store.js'
import { env } from '../../config/env.js'

// path → explicit override. Absent = default (ON for local projects).
// An explicit `false` (set via /channel off) disables it for that project.
type ChannelData = Record<string, boolean>

let store = createJsonFileStore<ChannelData>(resolve('data/channel-opt-in.json'), () => ({}))

/** Test-only: drop the cached store so a deleted file is re-read. */
export function __resetForTest(): void {
  store = createJsonFileStore<ChannelData>(resolve('data/channel-opt-in.json'), () => ({}))
}

/**
 * Channel is ON by default for LOCAL projects (Phase 1).
 * Remote projects (`remote:label`) are gated behind CHANNEL_REMOTE=1 (Phase 1.5).
 * Without that flag, remote sessions fall back to the classic -p path so they keep
 * their remote_* MCP + disallowedTools setup via claude-runner.
 * An explicit `false` override disables channel for a specific project regardless.
 */
export function isChannelEnabled(projectPath: string): boolean {
  if (isRemotePath(projectPath)) {
    if (env.CHANNEL_REMOTE !== '1') return false
    return store.load()[projectPath] !== false
  }
  return store.load()[projectPath] !== false
}

/** /channel on → clear override (back to default-on). /channel off → explicit off. */
export function setChannelEnabled(projectPath: string, on: boolean): void {
  const data = { ...store.load() }
  if (on) delete data[projectPath]
  else data[projectPath] = false
  store.save(data)
}
