/**
 * Agent-browser (ab_*) handlers for remote tools.
 * Chrome CDP connection, browser navigation, screenshots.
 */

import { readFile, stat, unlink } from 'node:fs/promises'
import { exec, execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { IS_WIN } from './index.js'

const AB_TIMEOUT_MS = 60_000 // 60s — heavy pages like Gmail need time to load
const CDP_PORT = 9222
const CDP_CHECK_URL = `http://localhost:${CDP_PORT}/json/version`
const CDP_FLAG = `--remote-debugging-port=${CDP_PORT}`

const BLOCKED_URL_RE =
  /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\]|0\.0\.0\.0)/i

/** Check if Chrome is listening on CDP port */
async function isCdpAvailable(): Promise<boolean> {
  try {
    const res = await fetch(CDP_CHECK_URL, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

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

export async function handleBrowserOpen(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const url = String(args.url)
  validateUrl(url)
  const text = await runAB('open', url)
  return text || `Navigated to ${url}`
}

export async function handleBrowserSnapshot(): Promise<string> {
  await ensureBrowserAvailable()
  return await runAB('snapshot', '-i')
}

export async function handleBrowserClick(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const ref = validateRef(args.ref)
  const text = await runAB('click', ref)
  return text || `Clicked ${ref}`
}

export async function handleBrowserFill(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const ref = validateRef(args.ref)
  const fillText = String(args.text)
  const text = await runAB('fill', ref, fillText)
  return text || `Filled ${ref}`
}

export async function handleBrowserPress(args: Record<string, unknown>): Promise<string> {
  await ensureBrowserAvailable()
  const key = validateKey(args.key)
  const text = await runAB('press', key)
  return text || `Pressed ${key}`
}

export async function handleBrowserScreenshot(): Promise<string> {
  await ensureBrowserAvailable()
  const screenshotPath = join(tmpdir(), `ab-screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
  await runAB('screenshot', '--output', screenshotPath)
  try {
    const buffer = await readFile(screenshotPath)
    const base64 = buffer.toString('base64')
    return JSON.stringify({ type: 'image', base64, mimeType: 'image/png' })
  } finally {
    await unlink(screenshotPath).catch(() => {})
  }
}

export async function handleBrowserBack(): Promise<string> {
  await ensureBrowserAvailable()
  const text = await runAB('back')
  return text || 'Navigated back'
}

export async function handleBrowserGetUrl(): Promise<string> {
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
export async function handleBrowserConnect(): Promise<string> {
  await ensureBrowserAvailable()

  // Step 1: Already connected?
  if (await isCdpAvailable()) {
    return `CDP already available on port ${CDP_PORT}. Browser tools will use your Chrome with login state.`
  }

  // Step 2: Find Chrome
  const chromePath = await findChromePath()

  // Step 2.5: Patch Chrome shortcuts to permanently include CDP flag
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
 */
export function handleSpawnDetached(args: Record<string, unknown>, baseDir: string): string {
  const cmd = String(args.command || 'npx')
  const cmdArgs: readonly string[] = args.args
    ? JSON.parse(String(args.args))
    : []
  const cwd = args.cwd ? String(args.cwd) : baseDir

  const child = spawn(cmd, [...cmdArgs], {
    cwd,
    detached: true,
    stdio: 'ignore',
    shell: false,
  })
  child.unref()

  return `Spawned detached: ${cmd} ${cmdArgs.join(' ')} (pid ${child.pid ?? 'unknown'})`
}
