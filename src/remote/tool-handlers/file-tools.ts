/**
 * File operation handlers for remote tools.
 * Read, write, list, search, fetch, push, list_projects.
 */

import { readFile, writeFile, readdir, stat, mkdir, open, rm, rename, copyFile } from 'node:fs/promises'
import { resolve, join, relative, sep, isAbsolute, dirname, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { MAX_FILE_SIZE, MAX_TRANSFER_SIZE, MAX_SEARCH_RESULTS, IS_WIN } from './index.js'

export async function handleReadFile(args: Record<string, unknown>, validatePath: (p: string) => string): Promise<string> {
  const filePath = validatePath(String(args.path))
  const stats = await stat(filePath)

  // Byte-range read when offset/limit provided
  const hasOffset = args.offset !== undefined && args.offset !== null
  const hasLimit = args.limit !== undefined && args.limit !== null
  if (hasOffset || hasLimit) {
    const byteOffset = Math.max(Number(args.offset) || 0, 0)
    const byteLimit = hasLimit
      ? Math.min(Math.max(Number(args.limit) || MAX_FILE_SIZE, 1), MAX_FILE_SIZE)
      : MAX_FILE_SIZE
    const readSize = Math.min(byteLimit, stats.size - byteOffset)
    if (readSize <= 0) {
      return `[bytes ${byteOffset}-${byteOffset} of ${stats.size}]\n(empty range)`
    }
    const fh = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(readSize)
      const { bytesRead } = await fh.read(buffer, 0, readSize, byteOffset)
      const endByte = byteOffset + bytesRead
      return `[bytes ${byteOffset}-${endByte} of ${stats.size}]\n` +
        buffer.toString('utf-8', 0, bytesRead)
    } finally {
      await fh.close()
    }
  }

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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

function formatMtime(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}`
}

export async function handleListDirectory(args: Record<string, unknown>, validatePath: (p: string) => string): Promise<string> {
  const dirPath = validatePath(String(args.path))
  const entries = await readdir(dirPath, { withFileTypes: true })
  const lines = await Promise.all(entries.map(async (entry) => {
    const type = entry.isDirectory() ? 'dir' : 'file'
    try {
      const fullPath = join(dirPath, entry.name)
      const s = await stat(fullPath)
      const size = entry.isDirectory() ? '' : ` ${formatFileSize(s.size)}`
      return `[${type}] ${entry.name} (${formatMtime(s.mtime)}${size ? ',' + size : ''})`
    } catch {
      return `[${type}] ${entry.name}`
    }
  }))
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

// --- P0-3: Delete ---

const SYSTEM_PATHS = IS_WIN
  ? [/^[a-z]:\\$/i, /^[a-z]:\\windows/i, /^[a-z]:\\program files/i, /^[a-z]:\\users$/i]
  : [/^\/$/, /^\/bin$/, /^\/sbin$/, /^\/usr$/, /^\/etc$/, /^\/var$/, /^\/dev$/, /^\/proc$/, /^\/sys$/]

function isSystemPath(p: string): boolean {
  const normalized = p.replace(/[\\/]+$/, '')
  return SYSTEM_PATHS.some((re) => re.test(normalized))
}

export async function handleDelete(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  baseDir: string,
): Promise<string> {
  const filePath = validatePath(String(args.path))
  const recursive = args.recursive === true

  // Safety: block system paths
  if (isSystemPath(filePath)) {
    throw new Error('Cannot delete system path')
  }

  // Safety: block deleting baseDir itself
  const normBase = resolve(baseDir)
  const normTarget = resolve(filePath)
  if (normTarget === normBase) {
    throw new Error('Cannot delete the base working directory')
  }

  // Safety: block deleting home dir root
  const normHome = resolve(homedir())
  if (normTarget === normHome) {
    throw new Error('Cannot delete the home directory')
  }

  const stats = await stat(filePath)
  if (stats.isDirectory() && !recursive) {
    throw new Error('Target is a directory — set recursive: true to delete directories')
  }

  await rm(filePath, { recursive, force: false })
  const relPath = relative(baseDir, filePath)
  return `Deleted ${stats.isDirectory() ? 'directory' : 'file'}: ${relPath}`
}

// --- P1-5: Move file ---

export async function handleMoveFile(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  baseDir: string,
): Promise<string> {
  const srcPath = validatePath(String(args.src))
  const destPath = validatePath(String(args.dest))

  // Ensure source exists
  await stat(srcPath)

  // Auto-create destination parent directory
  const destDir = dirname(destPath)
  await mkdir(destDir, { recursive: true })

  try {
    await rename(srcPath, destPath)
  } catch (err) {
    // Cross-device fallback: copy + delete
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await copyFile(srcPath, destPath)
      await rm(srcPath, { force: true })
    } else {
      throw err
    }
  }

  return `Moved ${relative(baseDir, srcPath)} → ${relative(baseDir, destPath)}`
}

// --- P1-9: Fetch archive ---

export async function handleFetchArchive(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
): Promise<string> {
  const targetPath = validatePath(String(args.path))
  const format = String(args.format || 'zip')

  // Validate target exists
  await stat(targetPath)

  const tmpPath = join(tmpdir(), `remote-archive-${Date.now()}.${format === 'tar.gz' ? 'tar.gz' : 'zip'}`)

  // Build the archive via execFile with ARRAY args (no shell), so a file whose
  // name contains shell metacharacters can't inject a command. Windows passes
  // the paths through env vars read back by PowerShell.
  const entryName = basename(targetPath)
  let bin: string
  let argv: string[]
  let opts: { timeout: number; windowsHide: boolean; cwd?: string; env?: NodeJS.ProcessEnv } = { timeout: 60_000, windowsHide: true }
  if (IS_WIN) {
    const ps = 'Compress-Archive -Path $env:CB_ARC_SRC -DestinationPath $env:CB_ARC_DEST -Force'
    bin = 'powershell'
    argv = ['-NoProfile', '-Command', ps]
    opts = { ...opts, env: { ...process.env, CB_ARC_SRC: targetPath, CB_ARC_DEST: tmpPath } }
  } else if (format === 'tar.gz') {
    bin = 'tar'
    argv = ['-czf', tmpPath, '-C', dirname(targetPath), entryName]
  } else {
    bin = 'zip'
    argv = ['-r', tmpPath, entryName]
    opts = { ...opts, cwd: dirname(targetPath) }
  }

  await new Promise<void>((res, rej) => {
    execFile(bin, argv, opts, (err) => {
      if (err) rej(new Error(`Archive creation failed: ${err.message}`))
      else res()
    })
  })

  try {
    const archiveStats = await stat(tmpPath)
    if (archiveStats.size > MAX_TRANSFER_SIZE) {
      throw new Error(`Archive too large: ${formatFileSize(archiveStats.size)} (max ${formatFileSize(MAX_TRANSFER_SIZE)})`)
    }

    const buffer = await readFile(tmpPath)
    const name = tmpPath.split(sep).pop() ?? 'archive'
    return JSON.stringify({ name, size: archiveStats.size, base64: buffer.toString('base64') })
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {})
  }
}

// --- Hub file relay: receive a project archive pushed FROM the hub (no clone) ---

/**
 * Extract a base64 .tar.gz (pushed by the hub over the relay) into baseDir/<name>.
 * This is how a fresh machine receives a project WITHOUT cloning from origin —
 * the hub holds/caches the source and streams it here; we only land the bytes
 * and extract. (node_modules isn't sent; the caller runs `npm install` after.)
 */
export async function handleWriteArchive(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  _baseDir: string,
): Promise<string> {
  const b64 = String(args.archive ?? '')
  if (!b64) throw new Error('No archive provided')
  const name = String(args.name ?? 'app').replace(/[^\w.-]/g, '') || 'app'
  const buf = Buffer.from(b64, 'base64')
  if (buf.length > MAX_TRANSFER_SIZE) {
    throw new Error(`Archive too large: ${formatFileSize(buf.length)} (max ${formatFileSize(MAX_TRANSFER_SIZE)})`)
  }

  const destDir = validatePath(name) // keeps it inside baseDir
  await mkdir(destDir, { recursive: true })
  const tmpPath = join(tmpdir(), `cb-deploy-${Date.now()}.tgz`)
  await writeFile(tmpPath, buf)
  try {
    await new Promise<void>((res, rej) => {
      execFile('tar', ['-xzf', tmpPath, '-C', destDir], { timeout: 120_000, windowsHide: true }, (err) => {
        if (err) rej(new Error(`extract failed: ${err.message}`)); else res()
      })
    })
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {})
  }
  return JSON.stringify({ ok: true, dir: destDir, bytes: buf.length })
}
