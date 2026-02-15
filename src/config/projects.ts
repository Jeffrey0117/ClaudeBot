import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ProjectInfo } from '../types/index.js'
import { env } from './env.js'

export function getBaseDirs(): readonly string[] {
  return env.PROJECTS_BASE_DIR.map((d) => resolve(d))
}

export function scanProjects(): readonly ProjectInfo[] {
  const results: ProjectInfo[] = []

  for (const baseDir of getBaseDirs()) {
    try {
      const entries = readdirSync(baseDir)
      for (const entry of entries) {
        const fullPath = join(baseDir, entry)
        try {
          if (statSync(fullPath).isDirectory() && !entry.startsWith('.')) {
            results.push({ name: entry, path: fullPath })
          }
        } catch {
          // skip inaccessible entries
        }
      }
    } catch (error) {
      console.warn(
        `Warning: Failed to scan projects directory "${baseDir}": ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return results
}

export function findProject(name: string): ProjectInfo | null {
  const projects = scanProjects()
  return projects.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null
}
