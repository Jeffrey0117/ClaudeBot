import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ProjectInfo } from '../types/index.js'
import { env } from './env.js'

export function scanProjects(): readonly ProjectInfo[] {
  const baseDir = resolve(env.PROJECTS_BASE_DIR)

  try {
    const entries = readdirSync(baseDir)
    return entries
      .filter((entry) => {
        const fullPath = join(baseDir, entry)
        try {
          return statSync(fullPath).isDirectory() && !entry.startsWith('.')
        } catch {
          return false
        }
      })
      .map((entry) => ({
        name: entry,
        path: join(baseDir, entry),
      }))
  } catch (error) {
    throw new Error(
      `Failed to scan projects directory "${baseDir}": ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function findProject(name: string): ProjectInfo | null {
  const projects = scanProjects()
  return projects.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null
}
