import { resolve } from 'node:path'
import { createJsonFileStore } from '../../utils/json-file-store.js'

export interface StoredScript {
  readonly name: string
  readonly code: string
  readonly match: readonly string[]
  readonly grants: readonly string[]
  readonly requires?: readonly string[]
  readonly resources?: ReadonlyArray<{ readonly name: string; readonly url: string }>
  readonly trigger?: string
  readonly addedAt: number
}

type Data = Record<string, StoredScript>

let store = createJsonFileStore<Data>(resolve('data/userscripts.json'), () => ({}))

/** Test-only: drop the cached store so a deleted file is re-read. */
export function __resetForTest(): void {
  store = createJsonFileStore<Data>(resolve('data/userscripts.json'), () => ({}))
}

export function addScript(s: StoredScript): void {
  store.save({ ...store.load(), [s.name]: s })
}

export function getScript(name: string): StoredScript | undefined {
  return store.load()[name]
}

export function listScripts(): StoredScript[] {
  return Object.values(store.load())
}

export function removeScript(name: string): boolean {
  const data = { ...store.load() }
  if (!(name in data)) return false
  delete data[name]
  store.save(data)
  return true
}
