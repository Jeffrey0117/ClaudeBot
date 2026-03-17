/**
 * Shared tool dispatch handlers for remote agent operations.
 * Used by both CLI agent (agent.ts) and Electron app.
 */

import { readFile, writeFile, readdir, stat, mkdir, open, unlink } from 'node:fs/promises'
import { exec, execFile, spawn } from 'node:child_process'
import { resolve, join, relative, sep, isAbsolute } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

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

    // On Windows, Node's shell:true uses %ComSpec% which may be unset or
    // point to a broken path in restricted environments. Use explicit fallback chain.
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

// Cache whether rg is available (checked once at first grep call)
let rgAvailable: boolean | null = null

function checkRgAvailable(): Promise<boolean> {
  return new Promise((res) => {
    exec('rg --version', { timeout: 3000, windowsHide: true }, (err) => res(!err))
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
    exec(cmd, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout) => {
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
    exec(cmd, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 256 * 1024, cwd: baseDir, windowsHide: true }, (error, stdout, stderr) => {
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
      exec(treeCmd, { timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true }, (_err, stdout) => {
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

async function handleListProjects(baseDir: string): Promise<string> {
  const entries = await readdir(baseDir, { withFileTypes: true })
  const projects: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    projects.push(entry.name)
  }
  return JSON.stringify(projects)
}

// --- Agent-Browser helpers (N-side) ---

const AB_TIMEOUT_MS = 60_000 // 60s — heavy pages like Gmail need time to load
const CDP_PORT = 9222
const CDP_CHECK_URL = `http://localhost:${CDP_PORT}/json/version`

/** Check if Chrome is listening on CDP port */
async function isCdpAvailable(): Promise<boolean> {
  try {
    const res = await fetch(CDP_CHECK_URL, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

const BLOCKED_URL_RE =
  /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\]|0\.0\.0\.0)/i

function validateUrl(url: string): void {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`)
    }
    if (BLOCKED_URL_RE.test(url)) {
      throw new Error('Access to internal/private URLs is not allowed')
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid URL: ${url}`)
    }
    throw error
  }
}

/** Run agent-browser CLI. Auto-prepends --cdp flag when Chrome CDP is available. */
async function runAB(...args: readonly string[]): Promise<string> {
  const cdp = await isCdpAvailable()
  const finalArgs = cdp ? ['--cdp', String(CDP_PORT), ...args] : [...args]

  return new Promise((resolve, reject) => {
    execFile(
      'agent-browser',
      finalArgs,
      { timeout: AB_TIMEOUT_MS, shell: true, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message
          reject(new Error(msg))
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

let abAvailable: boolean | null = null

function checkBrowserAvailable(): Promise<boolean> {
  return new Promise((res) => {
    execFile('agent-browser', ['--version'], { timeout: 3000, windowsHide: true, shell: true }, (err) => res(!err))
  })
}

async function ensureBrowserAvailable(): Promise<void> {
  // Only cache success — re-check every time if previously unavailable
  // so that installing via remote_execute_command takes effect immediately
  if (abAvailable !== true) abAvailable = await checkBrowserAvailable()
  if (!abAvailable) {
    throw new Error(
      'agent-browser is not installed on this machine. ' +
      'Use remote_execute_command to install it: npm i -g agent-browser — then retry the browser operation.',
    )
  }
}

function validateRef(ref: unknown): string {
  const s = String(ref)
  if (!/^e\d{1,6}$/.test(s)) throw new Error(`Invalid element ref: ${s}`)
  return s
}

function validateKey(key: unknown): string {
  const s = String(key)
  if (s.length > 50) throw new Error('Key name too long')
  return s
}

async function handleBrowserOpen(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const url = String(args.url)
  validateUrl(url)
  const text = await runAB('open', url)
  return text || `Navigated to ${url}`
}

async function handleBrowserSnapshot(): Promise<string> {
  await ensureBrowserAvailable()
  return await runAB('snapshot', '-i')
}

async function handleBrowserClick(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const ref = validateRef(args.ref)
  const text = await runAB('click', ref)
  return text || `Clicked ${ref}`
}

async function handleBrowserFill(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const ref = validateRef(args.ref)
  const fillText = String(args.text)
  const text = await runAB('fill', ref, fillText)
  return text || `Filled ${ref}`
}

async function handleBrowserPress(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const key = validateKey(args.key)
  const text = await runAB('press', key)
  return text || `Pressed ${key}`
}

async function handleBrowserScreenshot(): Promise<string> {
  await ensureBrowserAvailable()
  const screenshotPath = path.join(tmpdir(), `ab-screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
  await runAB('screenshot', '--output', screenshotPath)
  try {
    const buffer = await readFile(screenshotPath)
    const base64 = buffer.toString('base64')
    return JSON.stringify({ type: 'image', base64, mimeType: 'image/png' })
  } finally {
    await unlink(screenshotPath).catch(() => {})
  }
}

async function handleBrowserBack(): Promise<string> {
  await ensureBrowserAvailable()
  const text = await runAB('back')
  return text || 'Navigated back'
}

async function handleBrowserGetUrl(): Promise<string> {
  await ensureBrowserAvailable()
  return await runAB('get', 'url')
}

/**
 * Connect agent-browser to user's Chrome with CDP.
 *
 * Key insight: use GRACEFUL shutdown so Chrome saves session/cookies,
 * then restart with CDP + --restore-last-session.
 *
 * 1. CDP already open? → skip
 * 2. Find Chrome + patch shortcuts (permanent CDP)
 * 3. Kill agent-browser daemon (prevents old session conflict)
 * 4. Graceful Chrome close (WM_CLOSE) → saves session/cookies
 * 5. Force kill fallback after 8s
 * 6. Delete lockfiles
 * 7. Restart Chrome with CDP + session restore + anti-detection
 * 8. Poll CDP until confirmed
 */
async function handleBrowserConnect(): Promise<string> {
  await ensureBrowserAvailable()

  // Step 1: Already connected?
  if (await isCdpAvailable()) {
    return `CDP already available on port ${CDP_PORT}. Browser tools will use your Chrome with login state.`
  }

  // Step 2: Find Chrome
  const chromePath = await findChromePath()

  // Step 2.5: Patch Chrome shortcuts to permanently include CDP flag
  // So next time user opens Chrome normally, CDP is already on
  const patched = await patchChromeShortcuts()

  // Step 3: Kill agent-browser daemon (prevents old standalone session conflicting with CDP)
  await runAB('close').catch(() => {})

  // Step 4+5: Graceful Chrome shutdown → fallback to force kill
  await shutdownChrome()

  // Step 6: Delete lockfiles
  await deleteLockfiles()

  // Step 7: Launch Chrome with CDP + session restore + anti-detection
  const profileDir = IS_WIN
    ? join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
      : join(homedir(), '.config', 'google-chrome')

  // Detect which Chrome profile to use (user may not be on "Default")
  const profileName = await detectChromeProfile(profileDir)

  // Use exec + PowerShell Start-Process on Windows to avoid Node spawn quoting
  // --user-data-dir with spaces. Node spawn always adds quotes around args with
  // spaces, which Chrome misinterprets and silently ignores --remote-debugging-port.
  const commonArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    `--profile-directory=${profileName}`,
    '--restore-last-session',
    '--disable-blink-features=AutomationControlled',
  ]
  if (IS_WIN) {
    const psArgs = commonArgs.map((a) => `'${a}'`).join(',')
    exec(
      `powershell -NoProfile -Command "Start-Process '${chromePath}' -ArgumentList ${psArgs}"`,
      { windowsHide: true },
      () => {},
    )
  } else {
    const child = spawn(chromePath, commonArgs, { detached: true, stdio: 'ignore' })
    child.unref()
  }

  // Step 8: Poll CDP until ready (max 20s)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 800))
    if (await isCdpAvailable()) {
      const patchMsg = patched
        ? ` Chrome shortcuts patched — future launches will always have CDP.`
        : ''
      return (
        `Chrome restarted with CDP on port ${CDP_PORT}. ` +
        `Login state preserved. All ab_* tools will control your Chrome.${patchMsg}`
      )
    }
  }

  throw new Error(
    `Chrome started but CDP port ${CDP_PORT} not responding after 20s. ` +
    `Chrome path: ${chromePath}. Profile: ${profileDir}`,
  )
}

const CDP_FLAG = `--remote-debugging-port=${CDP_PORT}`

/**
 * Patch all Chrome .lnk shortcuts to include --remote-debugging-port.
 * Uses PowerShell COM (WScript.Shell) to read/write .lnk files.
 * Returns true if at least one shortcut was patched.
 */
async function patchChromeShortcuts(): Promise<boolean> {
  if (!IS_WIN) return false // macOS/Linux: TODO (.desktop files)

  const shortcutPaths = [
    // Taskbar pin
    join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Google Chrome.lnk'),
    // Desktop
    join(homedir(), 'Desktop', 'Google Chrome.lnk'),
    // Public desktop
    join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop', 'Google Chrome.lnk'),
    // Start menu (user)
    join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Google Chrome.lnk'),
    // Start menu (system)
    join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Google Chrome.lnk'),
  ]

  let patchedCount = 0
  for (const lnkPath of shortcutPaths) {
    try {
      await stat(lnkPath)
    } catch {
      continue // shortcut doesn't exist
    }

    try {
      // PowerShell: read shortcut arguments, append CDP flag if not present
      const ps = `
$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}')
if ($s.Arguments -notlike '*--remote-debugging-port=*') {
  $s.Arguments = ($s.Arguments + ' ${CDP_FLAG}').Trim()
  $s.Save()
  Write-Output 'PATCHED'
} else {
  Write-Output 'ALREADY'
}`.trim()

      const result = await new Promise<string>((res, rej) => {
        exec(
          `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`,
          { timeout: 5000, windowsHide: true },
          (err, stdout) => err ? rej(err) : res(stdout.trim()),
        )
      })

      if (result === 'PATCHED') patchedCount++
    } catch {
      // Skip this shortcut if PowerShell fails (permissions, etc.)
    }
  }

  return patchedCount > 0
}

/** Find Chrome executable. Common paths + Windows registry fallback. */
async function findChromePath(): Promise<string> {
  const candidates = IS_WIN
    ? [
        join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ]

  for (const p of candidates) {
    try {
      await stat(p)
      return p
    } catch { /* try next */ }
  }

  // Windows: ask registry
  if (IS_WIN) {
    try {
      const regResult = await new Promise<string>((res, rej) => {
        exec(
          'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
          { timeout: 3000, windowsHide: true },
          (err, stdout) => err ? rej(err) : res(stdout),
        )
      })
      const m = regResult.match(/REG_SZ\s+(.+\.exe)/i)
      if (m) {
        await stat(m[1].trim())
        return m[1].trim()
      }
    } catch { /* not found */ }
  }

  throw new Error('Chrome not found. Install Google Chrome.')
}

/**
 * Detect the Chrome profile the user actually uses.
 * Reads Local State → last_used_profiles, falls back to "Default".
 */
async function detectChromeProfile(userDataDir: string): Promise<string> {
  try {
    const localState = JSON.parse(
      await readFile(join(userDataDir, 'Local State'), 'utf-8'),
    ) as { profile?: { last_used?: string; info_cache?: Record<string, unknown> } }

    // Chrome stores the last used profile name
    if (localState.profile?.last_used) {
      return localState.profile.last_used
    }

    // Fallback: pick the first profile from info_cache
    const profiles = Object.keys(localState.profile?.info_cache ?? {})
    if (profiles.length > 0) {
      return profiles[0]
    }
  } catch {
    // Local State missing or unreadable
  }
  return 'Default'
}

/**
 * Shut down Chrome completely so the next launch owns the singleton.
 *
 * Windows Chrome single-instance: if ANY chrome.exe is still alive,
 * a new launch just talks to it and exits — CDP flag gets ignored.
 * Must kill the entire process tree including background/helper processes.
 */
async function shutdownChrome(): Promise<void> {
  if (IS_WIN) {
    // Step A: Graceful close (WM_CLOSE) → Chrome saves session/cookies
    await execPromise('taskkill /IM chrome.exe')

    // Wait for graceful exit (max 6s)
    if (await waitForChromeExit(6_000)) {
      // Even after graceful exit, wait for file handles to release
      await new Promise((res) => setTimeout(res, 500))
      return
    }

    // Step B: Force kill entire process tree (/T) + any chrome_proxy
    await execPromise('taskkill /F /T /IM chrome.exe')
    await execPromise('taskkill /F /IM chrome_proxy.exe')

    // Wait for force kill (max 3s)
    await waitForChromeExit(3_000)

    // Step C: Nuclear — kill anything holding CDP port
    await execPromise(
      `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${CDP_PORT} ^| findstr LISTENING') do taskkill /F /PID %a`,
    )
  } else {
    await execPromise('pkill -f chrome')
    if (await waitForChromeExit(6_000)) return
    await execPromise('pkill -9 -f chrome')
    await waitForChromeExit(3_000)
  }

  // Final wait for file handles / port release
  await new Promise((res) => setTimeout(res, 500))
}

/** Returns true if Chrome exited within timeoutMs. */
async function waitForChromeExit(timeoutMs: number): Promise<boolean> {
  const checkCmd = IS_WIN
    ? 'tasklist /FI "IMAGENAME eq chrome.exe" /NH'
    : 'pgrep -f chrome'

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 400))
    const alive = await new Promise<boolean>((res) => {
      exec(checkCmd, { timeout: 2000, windowsHide: true }, (err, stdout) => {
        if (err) { res(false); return }
        res(IS_WIN ? !stdout.includes('INFO:') && stdout.includes('chrome.exe') : stdout.trim().length > 0)
      })
    })
    if (!alive) return true
  }
  return false
}

/** Run exec and ignore errors (for kill commands that fail when no process). */
function execPromise(cmd: string): Promise<void> {
  return new Promise((res) => {
    exec(cmd, { windowsHide: true }, () => res())
  })
}

/** Delete Chrome profile lockfiles that prevent CDP from activating. */
async function deleteLockfiles(): Promise<void> {
  const profileDir = IS_WIN
    ? join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
      : join(homedir(), '.config', 'google-chrome')

  const locks = ['lockfile', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']
  for (const f of locks) {
    await unlink(join(profileDir, f)).catch(() => {})
  }
}

/**
 * Spawn a detached process that outlives the agent command.
 * Used by /pair chat to launch Electron without blocking.
 * args.command: executable name (e.g. 'npx')
 * args.args: JSON string array of arguments
 * args.cwd: optional working directory (defaults to baseDir)
 */
function handleSpawnDetached(args: Record<string, unknown>, baseDir: string): string {
  const cmd = String(args.command || 'npx')
  const cmdArgs: readonly string[] = args.args
    ? JSON.parse(String(args.args))
    : []
  const cwd = args.cwd ? String(args.cwd) : baseDir

  const child = spawn(cmd, [...cmdArgs], {
    cwd,
    detached: true,
    stdio: 'ignore',
    shell: true,
  })
  child.unref()

  return `Spawned detached: ${cmd} ${cmdArgs.join(' ')} (pid ${child.pid ?? 'unknown'})`
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
        case 'remote_list_projects': return handleListProjects(baseDir)
        case 'ab_open': return handleBrowserOpen(args)
        case 'ab_snapshot': return handleBrowserSnapshot()
        case 'ab_click': return handleBrowserClick(args)
        case 'ab_fill': return handleBrowserFill(args)
        case 'ab_press': return handleBrowserPress(args)
        case 'ab_screenshot': return handleBrowserScreenshot()
        case 'ab_back': return handleBrowserBack()
        case 'ab_get_url': return handleBrowserGetUrl()
        case 'ab_connect_browser': return handleBrowserConnect()
        case 'remote_spawn_detached': return handleSpawnDetached(args, baseDir)
        default: throw new Error(`Unknown tool: ${tool}`)
      }
    },
  }
}
