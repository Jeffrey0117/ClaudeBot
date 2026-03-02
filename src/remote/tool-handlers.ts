/**
 * Shared tool dispatch handlers for remote agent operations.
 * Used by both CLI agent (agent.ts) and Electron app.
 */

import { readFile, writeFile, readdir, stat, mkdir, open } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { resolve, join, relative, sep, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

const MAX_FILE_SIZE = 500 * 1024
const MAX_TRANSFER_SIZE = 20 * 1024 * 1024 // 20 MB for file transfer
const EXEC_TIMEOUT_MS = 30_000
const MAX_SEARCH_RESULTS = 50
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

async function handleReadFile(args: Record<string, unknown>, validatePath: (p: string) => string): Promise<string> {
  const filePath = validatePath(String(args.path))
  const stats = await stat(filePath)
  if (stats.size > MAX_FILE_SIZE) {
    // Read only the first MAX_FILE_SIZE bytes via fd to avoid OOM on huge files
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

async function handleWriteFile(
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

async function handleListDirectory(args: Record<string, unknown>, validatePath: (p: string) => string): Promise<string> {
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

async function handleSearchFiles(
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

async function handleExecuteCommand(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  baseDir: string,
): Promise<string> {
  const command = String(args.command)
  const cwd = args.cwd ? validatePath(String(args.cwd)) : baseDir
  return new Promise((res) => {
    exec(command, { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      const parts: string[] = []
      if (stdout.trim()) parts.push(stdout.trim())
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`)
      if (error && !stdout && !stderr) parts.push(`Error: ${error.message}`)
      res(parts.join('\n\n') || '(no output)')
    })
  })
}

async function handleFetchFile(args: Record<string, unknown>, validatePath: (p: string) => string): Promise<string> {
  const rawPath = String(args.path)
  // If relative path like "Desktop/file.txt", resolve against user's home directory
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

async function handlePushFile(args: Record<string, unknown>, validatePath: (p: string) => string): Promise<string> {
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

export interface ToolDispatcher {
  dispatch(tool: string, args: Record<string, unknown>): Promise<string>
}

export function createToolDispatcher(baseDir: string): ToolDispatcher {
  const validatePath = createPathValidator(baseDir)

  return {
    async dispatch(tool: string, args: Record<string, unknown>): Promise<string> {
      switch (tool) {
        case 'remote_read_file': return handleReadFile(args, validatePath)
        case 'remote_write_file': return handleWriteFile(args, validatePath, baseDir)
        case 'remote_list_directory': return handleListDirectory(args, validatePath)
        case 'remote_search_files': return handleSearchFiles(args, validatePath, baseDir)
        case 'remote_execute_command': return handleExecuteCommand(args, validatePath, baseDir)
        case 'remote_fetch_file': return handleFetchFile(args, validatePath)
        case 'remote_push_file': return handlePushFile(args, validatePath)
        default: throw new Error(`Unknown tool: ${tool}`)
      }
    },
  }
}
