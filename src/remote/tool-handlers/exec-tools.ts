/**
 * Command execution handlers for remote tools.
 * Execute, grep, system info, project overview.
 */

import { readFile } from 'node:fs/promises'
import { exec, execFile, spawn } from 'node:child_process'
import { join, sep } from 'node:path'
import { EXEC_TIMEOUT_MS, MAX_OUTPUT_SIZE, IS_WIN } from './index.js'

// Cache whether rg is available (checked once at first grep call)
let rgAvailable: boolean | null = null

function checkRgAvailable(): Promise<boolean> {
  return new Promise((res) => {
    exec('rg --version', { timeout: 3000, windowsHide: true }, (err) => res(!err))
  })
}

export async function handleExecuteCommand(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  baseDir: string,
): Promise<string> {
  const command = String(args.command)
  const cwd = args.cwd ? validatePath(String(args.cwd)) : baseDir
  const timeoutMs = Math.min(
    Math.max(Number(args.timeout) || EXEC_TIMEOUT_MS, 5_000),
    300_000,
  )

  return new Promise((res) => {
    const chunks: Buffer[] = []
    let totalSize = 0
    let truncated = false

    const shellOption = IS_WIN
      ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe')
      : true

    const child = spawn(command, {
      cwd,
      shell: shellOption,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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

export async function handleGrep(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  baseDir: string,
): Promise<string> {
  const pattern = String(args.pattern)
  const searchPath = args.path ? validatePath(String(args.path)) : baseDir
  const include = args.include ? String(args.include) : ''
  const maxResults = Math.min(Number(args.maxResults) || 100, 200)

  if (rgAvailable === null) rgAvailable = await checkRgAvailable()

  const escapedPattern = pattern.replace(/"/g, '\\"')
  const cmd = rgAvailable
    ? buildRgCommand(escapedPattern, searchPath, include, maxResults)
    : buildGrepCommand(escapedPattern, searchPath, include, maxResults)

  return new Promise((res) => {
    exec(cmd, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout) => {
      if (stdout.trim()) {
        const lines = stdout.trim().split('\n').slice(0, maxResults)
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
  const globFlag = include ? `--glob "${include}"` : ''
  return `rg -n --no-heading --max-count ${maxResults} ${globFlag} -- "${pattern}" "${searchPath}"`
}

function buildGrepCommand(pattern: string, searchPath: string, include: string, maxResults: number): string {
  const excludeDirs = '--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next'
  const includeFlag = include ? `--include="${include}"` : ''
  return `grep -rn ${excludeDirs} ${includeFlag} -m ${maxResults} -- "${pattern}" "${searchPath}"`
}

export function handleSystemInfo(baseDir: string): Promise<string> {
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
    exec(cmd, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 256 * 1024, cwd: baseDir, windowsHide: true }, (error, stdout, stderr) => {
      const parts: string[] = []
      if (stdout.trim()) parts.push(stdout.trim())
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`)
      if (error && !stdout && !stderr) parts.push(`Error: ${error.message}`)
      res(parts.join('\n\n') || '(no output)')
    })
  })
}

export async function handleProjectOverview(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
  baseDir: string,
): Promise<string> {
  const projectPath = args.path ? validatePath(String(args.path)) : baseDir
  const sections: string[] = []

  const treeCmd = IS_WIN
    ? `tree "${projectPath}" /F /A | findstr /N "^" | findstr /B "1: 2: 3: 4: 5: 6: 7: 8: 9: 10: 11: 12: 13: 14: 15: 16: 17: 18: 19: 20: 21: 22: 23: 24: 25: 26: 27: 28: 29: 30: 31: 32: 33: 34: 35: 36: 37: 38: 39: 40: 41: 42: 43: 44: 45: 46: 47: 48: 49: 50:"`
    : `find "${projectPath}" -maxdepth 2 -not -path "*/node_modules/*" -not -path "*/.git/*" | head -50`

  try {
    const tree = await new Promise<string>((res) => {
      exec(treeCmd, { timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true }, (_err, stdout) => {
        res(stdout.trim() || '(empty)')
      })
    })
    sections.push(`[Directory Structure]\n${tree}`)
  } catch {
    sections.push('[Directory Structure]\n(unavailable)')
  }

  const keyFiles = ['CLAUDE.md', 'package.json', 'README.md', 'Cargo.toml', 'pyproject.toml', 'go.mod']
  for (const name of keyFiles) {
    try {
      const content = await readFile(join(projectPath, name), 'utf-8')
      const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n...(truncated)' : content
      sections.push(`[${name}]\n${truncated}`)
    } catch { /* skip */ }
  }

  try {
    const gitStatus = await new Promise<string>((res) => {
      exec('git status --short && echo --- && git log --oneline -5', { cwd: projectPath, timeout: 10_000, windowsHide: true }, (_err, stdout) => {
        res(stdout.trim() || '(not a git repo)')
      })
    })
    sections.push(`[Git Status]\n${gitStatus}`)
  } catch {
    sections.push('[Git Status]\n(not a git repo)')
  }

  return sections.join('\n\n') || '(no project info found)'
}
