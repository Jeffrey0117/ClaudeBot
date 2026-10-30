import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface JsonFileStore<T> {
  load(): T
  save(data: T): void
}

export function createJsonFileStore<T>(filePath: string, makeDefault: () => T): JsonFileStore<T> {
  let cache: T | null = null
  let cachedMtimeMs = -1

  function currentMtime(): number {
    try {
      return statSync(filePath).mtimeMs
    } catch {
      return -1
    }
  }

  function load(): T {
    // The launcher runs N bot processes sharing these files — a forever-cache
    // serves stale data after a sibling writes, so invalidate by mtime.
    const mtimeMs = currentMtime()
    if (cache !== null && mtimeMs === cachedMtimeMs) return cache
    try {
      const raw = readFileSync(filePath, 'utf-8')
      cache = JSON.parse(raw) as T
    } catch {
      cache = makeDefault()
    }
    cachedMtimeMs = mtimeMs
    return cache
  }

  function save(data: T): void {
    mkdirSync(dirname(filePath), { recursive: true })
    // Unique tmp name — N processes writing `${filePath}.tmp` concurrently
    // interleave and corrupt each other.
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, filePath)
    cache = data
    cachedMtimeMs = currentMtime()
  }

  return { load, save }
}
