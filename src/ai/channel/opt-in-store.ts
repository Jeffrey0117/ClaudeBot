import { resolve } from 'node:path'
import { createJsonFileStore } from '../../utils/json-file-store.js'

type OptInData = Record<string, boolean>

let store = createJsonFileStore<OptInData>(resolve('data/channel-opt-in.json'), () => ({}))

/** Test-only: drop the cached store so a deleted file is re-read. */
export function __resetForTest(): void {
  store = createJsonFileStore<OptInData>(resolve('data/channel-opt-in.json'), () => ({}))
}

export function isChannelOptIn(projectPath: string): boolean {
  return store.load()[projectPath] === true
}

export function setChannelOptIn(projectPath: string, on: boolean): void {
  const data = { ...store.load() }
  if (on) data[projectPath] = true
  else delete data[projectPath]
  store.save(data)
}
