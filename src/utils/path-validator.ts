import { resolve, relative } from 'node:path'
import { getBaseDirs } from '../config/projects.js'

export function isPathSafe(targetPath: string): boolean {
  const resolved = resolve(targetPath)
  return getBaseDirs().some((baseDir) => {
    const rel = relative(baseDir, resolved)
    return !rel.startsWith('..') && !resolve(baseDir, rel).includes('..')
  })
}

export function validateProjectPath(projectPath: string): string {
  const resolved = resolve(projectPath)
  if (!isPathSafe(resolved)) {
    throw new Error(`Path traversal detected: "${projectPath}" is outside the allowed directories`)
  }
  return resolved
}
