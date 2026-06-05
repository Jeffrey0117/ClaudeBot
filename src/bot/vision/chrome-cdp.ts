/**
 * Chrome CDP setup — shared between /bv (Playwright) and remote ab_* tools.
 *
 * Responsibilities:
 *  - Detect whether Chrome DevTools Protocol is listening on port 9222
 *  - Find the user's Chrome executable
 *  - Patch Chrome shortcuts so future launches include --remote-debugging-port
 *  - Gracefully shut down existing Chrome (preserving session/cookies)
 *  - Relaunch Chrome with CDP + --restore-last-session
 *  - Poll until CDP is confirmed ready
 *
 * Previously lived inside src/remote/tool-handlers/browser-tools.ts as private
 * helpers. Extracted here so the Playwright-based /bv path can use the exact
 * same setup flow without duplicating logic.
 */

import { readFile, stat, unlink } from 'node:fs/promises'
import { exec, spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const CDP_PORT = 9222
export const CDP_CHECK_URL = `http://localhost:${CDP_PORT}/json/version`
export const CDP_FLAG = `--remote-debugging-port=${CDP_PORT}`

const IS_WIN = process.platform === 'win32'

// --- CDP availability ---

/** Check if Chrome is listening on CDP port (2s timeout). */
export async function isCdpAvailable(): Promise<boolean> {
  try {
    const res = await fetch(CDP_CHECK_URL, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

// --- Chrome discovery ---

/** Find Chrome executable. Common paths + Windows registry fallback. */
export async function findChromePath(): Promise<string> {
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

/** Chrome User Data directory for the current OS. */
export function getChromeProfileDir(): string {
  if (IS_WIN) return join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  return join(homedir(), '.config', 'google-chrome')
}

/**
 * Detect the Chrome profile the user actually uses.
 * Reads Local State → last_used_profiles, falls back to "Default".
 */
export async function detectChromeProfile(userDataDir: string): Promise<string> {
  try {
    const localState = JSON.parse(
      await readFile(join(userDataDir, 'Local State'), 'utf-8'),
    ) as { profile?: { last_used?: string; info_cache?: Record<string, unknown> } }

    if (localState.profile?.last_used) {
      return localState.profile.last_used
    }

    const profiles = Object.keys(localState.profile?.info_cache ?? {})
    if (profiles.length > 0) {
      return profiles[0]
    }
  } catch {
    // Local State missing or unreadable
  }
  return 'Default'
}

// --- Shortcut patching ---

/**
 * Patch all Chrome .lnk shortcuts to include --remote-debugging-port.
 * Uses PowerShell COM (WScript.Shell) to read/write .lnk files.
 * Returns true if at least one shortcut was newly patched.
 */
export async function patchChromeShortcuts(): Promise<boolean> {
  if (!IS_WIN) return false // macOS/Linux: TODO (.desktop files)

  const shortcutPaths = [
    join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Google Chrome.lnk'),
    join(homedir(), 'Desktop', 'Google Chrome.lnk'),
    join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop', 'Google Chrome.lnk'),
    join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Google Chrome.lnk'),
    join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Google Chrome.lnk'),
  ]

  let patchedCount = 0
  for (const lnkPath of shortcutPaths) {
    try {
      await stat(lnkPath)
    } catch {
      continue
    }

    try {
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

// --- Chrome shutdown + cleanup ---

/** Run exec and ignore errors (for kill commands that fail when no process). */
function execSilent(cmd: string): Promise<void> {
  return new Promise((res) => {
    exec(cmd, { windowsHide: true }, () => res())
  })
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

/**
 * Shut down Chrome completely so the next launch owns the singleton.
 *
 * Windows Chrome single-instance: if ANY chrome.exe is still alive,
 * a new launch just talks to it and exits — CDP flag gets ignored.
 * Must kill the entire process tree including helper processes.
 */
export async function shutdownChrome(): Promise<void> {
  if (IS_WIN) {
    // Step A: Graceful close (WM_CLOSE) → Chrome saves session/cookies
    await execSilent('taskkill /IM chrome.exe')

    if (await waitForChromeExit(6_000)) {
      await new Promise((res) => setTimeout(res, 500))
      return
    }

    // Step B: Force kill entire process tree + chrome_proxy
    await execSilent('taskkill /F /T /IM chrome.exe')
    await execSilent('taskkill /F /IM chrome_proxy.exe')
    await waitForChromeExit(3_000)

    // Step C: Nuclear — kill anything holding CDP port
    await execSilent(
      `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${CDP_PORT} ^| findstr LISTENING') do taskkill /F /PID %a`,
    )
  } else {
    await execSilent('pkill -f chrome')
    if (await waitForChromeExit(6_000)) return
    await execSilent('pkill -9 -f chrome')
    await waitForChromeExit(3_000)
  }

  await new Promise((res) => setTimeout(res, 500))
}

/** Delete Chrome profile lockfiles that prevent CDP from activating. */
export async function deleteLockfiles(): Promise<void> {
  const profileDir = getChromeProfileDir()
  const locks = ['lockfile', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']
  for (const f of locks) {
    await unlink(join(profileDir, f)).catch(() => {})
  }
}

// --- Chrome launch with CDP ---

/**
 * Launch Chrome with CDP port + session restore + anti-detection.
 * Does NOT check/kill existing Chrome — call shutdownChrome() first.
 */
export async function launchChromeWithCdp(): Promise<void> {
  const chromePath = await findChromePath()
  // Recent Chrome (M136+) IGNORES --remote-debugging-port when --user-data-dir
  // is the DEFAULT profile dir (security hardening). So we MUST use a dedicated
  // dir for CDP to actually open the port. Trade-off: it's a separate profile
  // (log into sites once there; it persists).
  const profileDir = getCdpProfileDir()
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) {
    await unlink(join(profileDir, f)).catch(() => {})
  }

  const args = [
    CDP_FLAG,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session',
    '--disable-blink-features=AutomationControlled',
  ]

  // spawn passes args as an array (no shell quoting), so paths with spaces and
  // the debug-port flag arrive intact — unlike cmd `start` / PowerShell.
  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

/** Dedicated, persistent user-data-dir for the CDP-controlled Chrome. */
export function getCdpProfileDir(): string {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, 'ClaudeBot', 'cdp-profile')
}

/**
 * Poll CDP port until it responds, or give up after timeoutMs.
 * Returns true if CDP became ready.
 */
export async function waitForCdp(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 800))
    if (await isCdpAvailable()) return true
  }
  return false
}

// --- High-level orchestration ---

export interface EnsureCdpResult {
  readonly alreadyAvailable: boolean
  readonly shortcutsPatched: boolean
  readonly message: string
}

/**
 * Ensure Chrome is running with CDP enabled.
 *
 * 1. CDP already open? → skip (fast path)
 * 2. Patch Chrome shortcuts so future manual launches include CDP flag
 * 3. Graceful Chrome shutdown (saves session/cookies)
 * 4. Delete profile lockfiles
 * 5. Relaunch Chrome with CDP + --restore-last-session
 * 6. Poll until CDP is confirmed ready
 *
 * Throws if Chrome is not installed or CDP fails to come up after 30s.
 */
export async function ensureChromeCdp(): Promise<EnsureCdpResult> {
  if (await isCdpAvailable()) {
    return {
      alreadyAvailable: true,
      shortcutsPatched: false,
      message: `CDP already available on port ${CDP_PORT}. Chrome is ready.`,
    }
  }

  // Validate Chrome exists before doing anything destructive
  const chromePath = await findChromePath()
  const patched = await patchChromeShortcuts()

  await shutdownChrome()
  await deleteLockfiles()
  await launchChromeWithCdp()

  if (await waitForCdp()) {
    const patchMsg = patched
      ? ' Chrome shortcuts patched — future launches will always have CDP.'
      : ''
    return {
      alreadyAvailable: false,
      shortcutsPatched: patched,
      message: `Chrome restarted with CDP on port ${CDP_PORT}. Login state preserved.${patchMsg}`,
    }
  }

  throw new Error(
    `Chrome started but CDP port ${CDP_PORT} not responding after 30s. ` +
    `Chrome path: ${chromePath}`,
  )
}
