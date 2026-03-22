/**
 * File operation handlers for remote tools.
 * Read, write, list, search, fetch, push, list_projects.
 */

import { readFile, writeFile, readdir, stat, mkdir, open } from 'node:fs/promises'
import { resolve, join, relative, sep, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { MAX_FILE_SIZE, MAX_TRANSFER_SIZE, MAX_SEARCH_RESULTS } from './index.js'

export async function handleReadFile(args: Record<string, unknown>, validatePath: (p: string) => string): Promise<string> {
  const filePath = validatePath(String(args.path))
  const stats = await stat(filePath)
  if (stats.size > MAX_FILE_SIZE) {
    const fh = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(MAX_FILE_SIZE)
      const { bytesRead } = await fh.read(buffer, 0, MAX_FILE_SIZE, 0)
      return buffer.toString('utf-8', 0, bytesRead) +
        `\n\n[truncated at ${MAX_FILE_SIZE} bytes, total: ${stats.size}]`
    } finally {
      await fh.close()
    }
  }
  return await readFile(filePath, 'utf-8')
}

export async function handleWriteFile(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  baseDir: string,
): Promise<string> {
  const filePath = validatePath(String(args.path))
  const content = String(args.content)
  const dir = resolve(filePath, '..')
  await mkdir(dir, { recursive: true })
  await writeFile(filePath, content, 'utf-8')
  return `Written ${content.length} bytes to ${relative(baseDir, filePath)}`
}

export async function handleListDirectory(args: Record<string, unknown>, validatePath: (p: string) => string): Promise<string> {
  const dirPath = validatePath(String(args.path))
  const entries = await readdir(dirPath, { withFileTypes: true })
  const lines = entries.map((entry) => {
    const type = entry.isDirectory() ? 'dir' : 'file'
    return `[${type}] ${entry.name}`
  })
  return lines.join('\n') || '(empty directory)'
}

function matchGlob(name: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1))
  return name.includes(pattern)
}

export async function handleSearchFiles(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  baseDir: string,
): Promise<string> {
  const searchPath = validatePath(String(args.path))
  const pattern = String(args.pattern || '*')
  const contentPattern = args.contentPattern ? String(args.contentPattern) : undefined
  const results: string[] = []

  async function walk(dir: string): Promise<void> {
    if (results.length >= MAX_SEARCH_RESULTS) return
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (results.length >= MAX_SEARCH_RESULTS) break
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === '.git')) continue
        if (entry.isDirectory()) {
          await walk(fullPath)
        } else if (matchGlob(entry.name, pattern)) {
          if (contentPattern) {
            try {
              const content = await readFile(fullPath, 'utf-8')
              if (content.includes(contentPattern)) {
                results.push(relative(baseDir, fullPath))
              }
            } catch { /* skip binary */ }
          } else {
            results.push(relative(baseDir, fullPath))
          }
        }
      }
    } catch { /* skip inaccessible */ }
  }

  await walk(searchPath)
  const suffix = results.length >= MAX_SEARCH_RESULTS ? `\n(limited to ${MAX_SEARCH_RESULTS} results)` : ''
  return results.join('\n') + suffix || '(no matches)'
}

export async function handleFetchFile(args: Record<string, unknown>, validatePath: (p: string) => string): Promise<string> {
  const rawPath = String(args.path)
  const isAbs = isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath)
  const expandedPath = isAbs ? rawPath : join(homedir(), rawPath)
  const filePath = validatePath(expandedPath)
  const stats = await stat(filePath)
  if (stats.size > MAX_TRANSFER_SIZE) {
    throw new Error(`File too large: ${stats.size} bytes (max ${MAX_TRANSFER_SIZE})`)
  }
  const buffer = await readFile(filePath)
  const name = filePath.split(sep).pop() ?? 'file'
  return JSON.stringify({ name, size: stats.size, base64: buffer.toString('base64') })
}

export async function handlePushFile(args: Record<string, unknown>, validatePath: (p: string) => string): Promise<string> {
  const filePath = validatePath(String(args.path))
  const base64 = String(args.base64)
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > MAX_TRANSFER_SIZE) {
    throw new Error(`File too large: ${buffer.length} bytes (max ${MAX_TRANSFER_SIZE})`)
  }
  const dir = resolve(filePath, '..')
  await mkdir(dir, { recursive: true })
  await writeFile(filePath, buffer)
  return `Written ${buffer.length} bytes to ${filePath}`
}

export async function handleListProjects(baseDir: string): Promise<string> {
  const entries = await readdir(baseDir, { withFileTypes: true })
  const projects: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    projects.push(entry.name)
  }
  return JSON.stringify(projects)
}
