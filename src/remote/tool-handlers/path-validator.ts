/**
 * Path validation utilities for remote tool handlers.
 * Ensures file operations stay within allowed directories.
 */

import { resolve, sep, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

const IS_WIN = process.platform === 'win32'

function normalizeCmp(p: string): string {
  return IS_WIN ? p.toLowerCase() : p
}

function isUnderDir(target: string, dir: string): boolean {
  const cmpTarget = normalizeCmp(target)
  const cmpDir = normalizeCmp(dir)
  return cmpTarget === cmpDir || cmpTarget.startsWith(cmpDir + sep)
}

export function createPathValidator(baseDir: string): (targetPath: string) => string {
  const normalizedBase = resolve(baseDir)
  const homeDir = resolve(homedir())

  return (targetPath: string): string => {
    // Block UNC paths
    if (targetPath.startsWith('\\\\') || targetPath.startsWith('//')) {
      throw new Error('UNC paths not allowed')
    }

    const isAbs = isAbsolute(targetPath) || /^[a-zA-Z]:/.test(targetPath)
    const resolved = isAbs ? resolve(targetPath) : resolve(normalizedBase, targetPath)

    // Absolute paths: must be within user's home directory
    if (isAbs) {
      if (!isUnderDir(resolved, homeDir)) {
        throw new Error(`Absolute path must be within home directory (${homeDir})`)
      }
      return resolved
    }

    // Relative paths: must stay within baseDir
    if (!isUnderDir(resolved, normalizedBase)) {
      throw new Error('Path traversal blocked')
    }
    return resolved
  }
}
