import { resolve, relative } from 'node:path'
import { env } from '../config/env.js'

export function isPathSafe(targetPath: string): boolean {
  const baseDir = resolve(env.PROJECTS_BASE_DIR)
  const resolved = resolve(targetPath)
  const rel = relative(baseDir, resolved)
  return !rel.startsWith('..') && !resolve(baseDir, rel).includes('..')
}

export function validateProjectPath(projectPath: string): string {
  const resolved = resolve(projectPath)
  if (!isPathSafe(resolved)) {
    throw new Error(`Path traversal detected: "${projectPath}" is outside the allowed directory`)
  }
  return resolved
}
