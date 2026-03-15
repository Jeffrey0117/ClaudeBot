import { resolve } from 'node:path'
import { createJsonFileStore } from '../../utils/json-file-store.js'
import type { Chain } from './chain-types.js'

const DATA_PATH = resolve('data/chains.json')
const store = createJsonFileStore<Chain[]>(DATA_PATH, () => [])

export function listChains(): readonly Chain[] {
  return store.load()
}

export function getChain(name: string): Chain | null {
  return store.load().find((c) => c.name === name) ?? null
}

export function saveChain(chain: Chain): void {
  const all = store.load().filter((c) => c.name !== chain.name)
  store.save([...all, chain])
}

export function deleteChain(name: string): boolean {
  const all = store.load()
  const filtered = all.filter((c) => c.name !== name)
  if (filtered.length === all.length) return false
  store.save(filtered)
  return true
}

export function updateChainSchedule(name: string, schedule: string | undefined): boolean {
  const all = store.load()
  const idx = all.findIndex((c) => c.name === name)
  if (idx === -1) return false
  const updated = all.map((c) =>
    c.name === name ? { ...c, schedule } : c,
  )
  store.save(updated)
  return true
}
