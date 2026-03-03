/**
 * Shared tool dispatch handlers for remote agent operations.
 * Used by both CLI agent (agent.ts) and Electron app.
 */

import { readFile, writeFile, readdir, stat, mkdir, open } from 'node:fs/promises'
import { exec, spawn } from 'node:child_process'
import { resolve, join, relative, sep, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

const MAX_FILE_SIZE = 500 * 1024
const MAX_TRANSFER_SIZE = 20 * 1024 * 1024 // 20 MB for file transfer
const EXEC_TIMEOUT_MS = 120_000
const MAX_OUTPUT_SIZE = 1024 * 1024 // 1 MB output cap
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

/**
 * Execute a shell command using spawn for streaming output.
 * Supports up to 120s timeout and 1MB output cap.
 */
async function handleExecuteCommand(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  baseDir: string,
): Promise<string> {
  const command = String(args.command)
  const cwd = args.cwd ? validatePath(String(args.cwd)) : baseDir
  const timeoutMs = Math.min(
    Math.max(Number(args.timeout) || EXEC_TIMEOUT_MS, 5_000),
    300_000, // hard cap 5 minutes
  )

  return new Promise((res) => {
    const chunks: Buffer[] = []
    let totalSize = 0
    let truncated = false

    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 3_000)
    }, timeoutMs)

    function collectChunk(chunk: Buffer): void {
      if (truncated) return
      totalSize += chunk.length
      if (totalSize > MAX_OUTPUT_SIZE) {
        truncated = true
        chunks.push(chunk.subarray(0, chunk.length - (totalSize - MAX_OUTPUT_SIZE)))
      } else {
        chunks.push(chunk)
      }
    }

    child.stdout.on('data', collectChunk)
    child.stderr.on('data', collectChunk)

    child.on('close', (code) => {
      clearTimeout(timer)
      const output = Buffer.concat(chunks).toString('utf-8').trim()
      const parts: string[] = []
      if (output) parts.push(output)
      if (truncated) parts.push(`\n[output truncated at ${MAX_OUTPUT_SIZE} bytes]`)
      if (code !== 0 && code !== null) parts.push(`[exit code: ${code}]`)
      res(parts.join('\n') || '(no output)')
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      res(`Error: ${err.message}`)
    })
  })
}

// Cache whether rg is available (checked once at first grep call)
let rgAvailable: boolean | null = null

function checkRgAvailable(): Promise<boolean> {
  return new Promise((res) => {
    exec('rg --version', { timeout: 3000 }, (err) => res(!err))
  })
}

async function handleGrep(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  baseDir: string,
): Promise<string> {
  const pattern = String(args.pattern)
  const searchPath = args.path ? validatePath(String(args.path)) : baseDir
  const include = args.include ? String(args.include) : ''
  const maxResults = Math.min(Number(args.maxResults) || 100, 200)

  // Check rg availability once
  if (rgAvailable === null) rgAvailable = await checkRgAvailable()

  const escapedPattern = pattern.replace(/"/g, '\\"')
  const cmd = rgAvailable
    ? buildRgCommand(escapedPattern, searchPath, include, maxResults)
    : buildGrepCommand(escapedPattern, searchPath, include, maxResults)

  return new Promise((res) => {
    exec(cmd, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 512 * 1024 }, (error, stdout) => {
      if (stdout.trim()) {
        const lines = stdout.trim().split('\n').slice(0, maxResults)
        // Make paths relative to baseDir for readability
        const relativized = lines.map((line) => {
          const prefix = searchPath + sep
          return line.startsWith(prefix) ? line.slice(prefix.length) : line
        })
        res(relativized.join('\n'))
      } else if (error && (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        res('(output too large, narrow your search)')
      } else {
        res('(no matches)')
      }
    })
  })
}

function buildRgCommand(pattern: string, searchPath: string, include: string, maxResults: number): string {
  // ripgrep: auto-respects .gitignore, much faster, better regex
  const globFlag = include ? `--glob "${include}"` : ''
  return `rg -n --no-heading --max-count ${maxResults} ${globFlag} -- "${pattern}" "${searchPath}"`
}

function buildGrepCommand(pattern: string, searchPath: string, include: string, maxResults: number): string {
  const excludeDirs = '--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next'
  const includeFlag = include ? `--include="${include}"` : ''
  return `grep -rn ${excludeDirs} ${includeFlag} -m ${maxResults} -- "${pattern}" "${searchPath}"`
}

function handleSystemInfo(baseDir: string): Promise<string> {
  const cmds = IS_WIN
    ? [
        'echo [OS] && ver',
        'echo [User] && whoami',
        `echo [Working Dir] && echo ${baseDir}`,
        'echo [Disk] && wmic logicaldisk get size,freespace,caption /format:list 2>nul || echo (unavailable)',
        'echo [Memory] && powershell -NoProfile -Command "[math]::Round((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1MB,1).ToString()+\' GB total, \'+[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1).ToString()+\' GB free\'"',
        'echo [Network] && ipconfig | findstr /R "IPv4"',
      ]
    : [
        'echo "[OS]" && uname -a',
        'echo "[User]" && whoami',
        `echo "[Working Dir]" && echo ${baseDir}`,
        'echo "[Disk]" && df -h / 2>/dev/null || echo "(unavailable)"',
        'echo "[Memory]" && free -h 2>/dev/null || vm_stat 2>/dev/null || echo "(unavailable)"',
        'echo "[Network]" && hostname -I 2>/dev/null || ifconfig | grep inet 2>/dev/null || echo "(unavailable)"',
      ]

  const cmd = cmds.join(' && ')
  return new Promise((res) => {
    exec(cmd, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 256 * 1024, cwd: baseDir }, (error, stdout, stderr) => {
      const parts: string[] = []
      if (stdout.trim()) parts.push(stdout.trim())
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`)
      if (error && !stdout && !stderr) parts.push(`Error: ${error.message}`)
      res(parts.join('\n\n') || '(no output)')
    })
  })
}

async function handleProjectOverview(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  baseDir: string,
): Promise<string> {
  const projectPath = args.path ? validatePath(String(args.path)) : baseDir
  const sections: string[] = []

  // 1. Directory tree (2 levels deep)
  const treeCmd = IS_WIN
    ? `tree "${projectPath}" /F /A | findstr /N "^" | findstr /B "1: 2: 3: 4: 5: 6: 7: 8: 9: 10: 11: 12: 13: 14: 15: 16: 17: 18: 19: 20: 21: 22: 23: 24: 25: 26: 27: 28: 29: 30: 31: 32: 33: 34: 35: 36: 37: 38: 39: 40: 41: 42: 43: 44: 45: 46: 47: 48: 49: 50:"`
    : `find "${projectPath}" -maxdepth 2 -not -path "*/node_modules/*" -not -path "*/.git/*" | head -50`

  try {
    const tree = await new Promise<string>((res) => {
      exec(treeCmd, { timeout: 10_000, maxBuffer: 128 * 1024 }, (_err, stdout) => {
        res(stdout.trim() || '(empty)')
      })
    })
    sections.push(`[Directory Structure]\n${tree}`)
  } catch {
    sections.push('[Directory Structure]\n(unavailable)')
  }

  // 2. Key files: CLAUDE.md, package.json, README.md
  const keyFiles = ['CLAUDE.md', 'package.json', 'README.md', 'Cargo.toml', 'pyproject.toml', 'go.mod']
  for (const name of keyFiles) {
    try {
      const content = await readFile(join(projectPath, name), 'utf-8')
      const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n...(truncated)' : content
      sections.push(`[${name}]\n${truncated}`)
    } catch {
      // File doesn't exist — skip silently
    }
  }

  // 3. Git status
  try {
    const gitStatus = await new Promise<string>((res) => {
      exec('git status --short && echo --- && git log --oneline -5', { cwd: projectPath, timeout: 10_000 }, (_err, stdout) => {
        res(stdout.trim() || '(not a git repo)')
      })
    })
    sections.push(`[Git Status]\n${gitStatus}`)
  } catch {
    sections.push('[Git Status]\n(not a git repo)')
  }

  return sections.join('\n\n') || '(no project info found)'
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
        case 'remote_grep': return handleGrep(args, validatePath, baseDir)
        case 'remote_system_info': return handleSystemInfo(baseDir)
        case 'remote_project_overview': return handleProjectOverview(args, validatePath, baseDir)
        case 'remote_fetch_file': return handleFetchFile(args, validatePath)
        case 'remote_push_file': return handlePushFile(args, validatePath)
        default: throw new Error(`Unknown tool: ${tool}`)
      }
    },
  }
}
