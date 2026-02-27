import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface JsonFileStore<T> {
  load(): T
  save(data: T): void
}

export function createJsonFileStore<T>(filePath: string, makeDefault: () => T): JsonFileStore<T> {
  let cache: T | null = null

  function load(): T {
    if (cache) return cache
    try {
      const raw = readFileSync(filePath, 'utf-8')
      cache = JSON.parse(raw) as T
    } catch {
      cache = makeDefault()
    }
    return cache
  }

  function save(data: T): void {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, filePath)
    cache = data
  }

  return { load, save }
}
