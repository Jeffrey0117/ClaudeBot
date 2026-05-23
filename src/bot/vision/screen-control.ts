/**
 * Screen-level automation — screenshot, mouse, keyboard via PowerShell/.NET.
 * Zero npm dependencies. Windows only.
 *
 * Strategy: find Chrome window → determine its monitor → capture that monitor.
 * Capture does NOT touch Chrome (no maximize, no foreground switch).
 * Only click/type/press activate Chrome via SetForegroundWindow.
 */

import { exec, execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'

/** Legacy constants — kept for backward compat with web-agent imports. */
export const IMAGE_WIDTH = 1280
export const IMAGE_HEIGHT = 720

/** Run a PowerShell script via -EncodedCommand for reliable quoting. */
function runPS(script: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    exec(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message))
        else resolve(stdout.trim())
      },
    )
  })
}

export interface ScreenCapture {
  readonly filePath: string
  /** Monitor width in physical pixels. */
  readonly clientWidth: number
  /** Monitor height in physical pixels. */
  readonly clientHeight: number
  /** Monitor top-left X in virtual screen coordinates. */
  readonly originX: number
  /** Monitor top-left Y in virtual screen coordinates. */
  readonly originY: number
}

// Shared Win32 type definition
const WIN32_TYPES =
  `Add-Type @'\n` +
  `using System; using System.Runtime.InteropServices;\n` +
  `[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }\n` +
  `public class Win {\n` +
  `  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\n` +
  `  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);\n` +
  `  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);\n` +
  `  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\n` +
  `  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);\n` +
  `  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);\n` +
  `  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);\n` +
  `  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint fl, int ex);\n` +
  `  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);\n` +
  `  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, int d, int ex);\n` +
  // Alt key trick: allows SetForegroundWindow from background processes
  `  public static void ForceActivate(IntPtr h) {\n` +
  `    keybd_event(0x12, 0, 0, 0);\n` +
  `    keybd_event(0x12, 0, 2, 0);\n` +
  `    SetForegroundWindow(h);\n` +
  `  }\n` +
  `  public static void Click(int x, int y) {\n` +
  // Convert screen coords → absolute 0-65535 virtual screen coords
  `    int vsX = GetSystemMetrics(76), vsY = GetSystemMetrics(77);\n` +
  `    int vsW = GetSystemMetrics(78), vsH = GetSystemMetrics(79);\n` +
  `    int absX = (x - vsX) * 65535 / vsW;\n` +
  `    int absY = (y - vsY) * 65535 / vsH;\n` +
  `    mouse_event(0x04, 0, 0, 0, 0);\n` +          // Safety LEFTUP
  // ABSOLUTE|MOVE generates proper WM_MOUSEMOVE (SetCursorPos doesn't!)
  `    mouse_event(0x8001, absX, absY, 0, 0);\n` +
  `    System.Threading.Thread.Sleep(150);\n` +
  `    mouse_event(0x8002, absX, absY, 0, 0);\n` +  // ABSOLUTE|LEFTDOWN
  `    System.Threading.Thread.Sleep(80);\n` +
  `    mouse_event(0x8004, absX, absY, 0, 0);\n` +  // ABSOLUTE|LEFTUP
  `    System.Threading.Thread.Sleep(100);\n` +
  `  }\n` +
  `  public static void Scroll(int d) { mouse_event(0x0800, 0, 0, d * 120, 0); }\n` +
  `}\n` +
  `'@\n`

/**
 * Enumerate ALL Chrome_WidgetWin_1 windows, pick the LARGEST visible one.
 * Sets $best to the hwnd.
 */
const FIND_BEST_CHROME =
  `$best = [IntPtr]::Zero; $bestArea = 0; $h = [IntPtr]::Zero\n` +
  `while ($true) {\n` +
  `  $h = [Win]::FindWindowEx([IntPtr]::Zero, $h, "Chrome_WidgetWin_1", $null)\n` +
  `  if ($h -eq [IntPtr]::Zero) { break }\n` +
  `  if (![Win]::IsWindowVisible($h)) { continue }\n` +
  `  $r = New-Object RECT; [Win]::GetClientRect($h, [ref]$r) | Out-Null\n` +
  `  $sz = $r.Right * $r.Bottom\n` +
  `  if ($sz -gt $bestArea) { $bestArea = $sz; $best = $h }\n` +
  `}\n`

/**
 * Find Chrome window, determine which monitor it's on, capture that monitor.
 * Does NOT touch Chrome — no maximize, no foreground switch, no window manipulation.
 */
export async function captureScreen(): Promise<ScreenCapture> {
  const filePath = join(tmpdir(), `bv-screen-${randomBytes(4).toString('hex')}.png`)
  const psPath = filePath.replace(/'/g, "''")

  const output = await runPS(
    WIN32_TYPES +
    `Add-Type -AssemblyName System.Drawing\n` +
    `Add-Type -AssemblyName System.Windows.Forms\n` +
    // Find largest visible Chrome window
    FIND_BEST_CHROME +
    `if ($best -ne [IntPtr]::Zero) { $hwnd = $best } else { $hwnd = [Win]::GetForegroundWindow() }\n` +
    // Get window position to determine which monitor it's on
    `$wr = New-Object RECT; [Win]::GetWindowRect($hwnd, [ref]$wr) | Out-Null\n` +
    `$cx = [int](($wr.Left + $wr.Right) / 2)\n` +
    `$cy = [int](($wr.Top + $wr.Bottom) / 2)\n` +
    `$scr = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($cx, $cy)))\n` +
    `$sb = $scr.Bounds\n` +
    // Capture the monitor — no window manipulation, just screenshot
    `$bmp = New-Object System.Drawing.Bitmap($sb.Width, $sb.Height)\n` +
    `$g = [System.Drawing.Graphics]::FromImage($bmp)\n` +
    `$g.CopyFromScreen($sb.X, $sb.Y, 0, 0, (New-Object System.Drawing.Size($sb.Width, $sb.Height)))\n` +
    `$g.Dispose()\n` +
    `$bmp.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png)\n` +
    `$bmp.Dispose()\n` +
    // Output: monitorW|monitorH|monitorX|monitorY
    `Write-Output "$($sb.Width)|$($sb.Height)|$($sb.X)|$($sb.Y)"`,
    20_000,
  )

  const parts = output.split('|').map((s) => parseInt(s.trim(), 10))
  return {
    filePath,
    clientWidth: parts[0] || 1920,
    clientHeight: parts[1] || 1080,
    originX: parts[2] || 0,
    originY: parts[3] || 0,
  }
}

/** Read screenshot file as base64 and delete the temp file. */
export async function readScreenshotBase64(filePath: string): Promise<string> {
  const buffer = await readFile(filePath)
  await unlink(filePath).catch(() => {})
  return buffer.toString('base64')
}

/**
 * Click at Gemini coordinates (1:1 mapping — full resolution, no scaling).
 * Activates Chrome ONCE before clicking.
 */
export async function clickScreen(capture: ScreenCapture, geminiX: number, geminiY: number): Promise<void> {
  const screenX = Math.round(capture.originX + geminiX)
  const screenY = Math.round(capture.originY + geminiY)
  await runPS(
    WIN32_TYPES +
    // Alt key trick → ForceActivate Chrome (bypasses Windows background process restriction)
    FIND_BEST_CHROME +
    `if ($best -ne [IntPtr]::Zero) {\n` +
    `  [Win]::ForceActivate($best)\n` +
    `  Start-Sleep -Milliseconds 500\n` +
    `}\n` +
    `[Win]::Click(${screenX}, ${screenY})`,
  )
}

/** Type text via SendKeys. Click the target field first with clickScreen(). */
export async function typeScreen(text: string): Promise<void> {
  const escaped = text.replace(/([+^%~(){}[\]])/g, '{$1}')
  const safe = escaped.replace(/'/g, "''")
  await runPS(
    `Add-Type -AssemblyName System.Windows.Forms\n` +
    `[System.Windows.Forms.SendKeys]::SendWait('${safe}')`,
  )
}

/** Press a special key (Enter, Tab, Escape, etc.). */
export async function pressScreen(key: string): Promise<void> {
  const keyMap: Record<string, string> = {
    Enter: '{ENTER}', Tab: '{TAB}', Escape: '{ESC}',
    Backspace: '{BACKSPACE}', Delete: '{DELETE}',
    ArrowUp: '{UP}', ArrowDown: '{DOWN}',
    ArrowLeft: '{LEFT}', ArrowRight: '{RIGHT}',
    Home: '{HOME}', End: '{END}',
  }
  const sendKey = keyMap[key] || `{${key.toUpperCase()}}`
  await runPS(
    `Add-Type -AssemblyName System.Windows.Forms\n` +
    `[System.Windows.Forms.SendKeys]::SendWait('${sendKey}')`,
  )
}

/** Find Chrome, activate it, return its monitor bounds. */
export async function activateChrome(): Promise<{ originX: number; originY: number; width: number; height: number }> {
  const output = await runPS(
    WIN32_TYPES +
    `Add-Type -AssemblyName System.Drawing\n` +
    `Add-Type -AssemblyName System.Windows.Forms\n` +
    FIND_BEST_CHROME +
    `if ($best -eq [IntPtr]::Zero) { Write-Output "NOCHROME"; exit 0 }\n` +
    `[Win]::ForceActivate($best)\n` +
    `Start-Sleep -Milliseconds 500\n` +
    `$wr = New-Object RECT; [Win]::GetWindowRect($best, [ref]$wr) | Out-Null\n` +
    `$cx = [int](($wr.Left + $wr.Right) / 2)\n` +
    `$cy = [int](($wr.Top + $wr.Bottom) / 2)\n` +
    `$scr = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($cx, $cy)))\n` +
    `$sb = $scr.Bounds\n` +
    `Write-Output "$($sb.Width)|$($sb.Height)|$($sb.X)|$($sb.Y)"`,
  )
  if (output === 'NOCHROME') throw new Error('找不到 Chrome 視窗')
  const parts = output.split('|').map((s) => parseInt(s.trim(), 10))
  return {
    width: parts[0] || 1920,
    height: parts[1] || 1080,
    originX: parts[2] || 0,
    originY: parts[3] || 0,
  }
}

/** Click at absolute screen coordinates (handles multi-monitor via GetSystemMetrics). */
export async function clickAt(x: number, y: number): Promise<void> {
  await runPS(
    WIN32_TYPES +
    `[Win]::Click(${Math.round(x)}, ${Math.round(y)})`,
  )
}

/** Scroll up or down at current mouse position. */
export async function scrollScreen(direction: 'up' | 'down'): Promise<void> {
  const delta = direction === 'up' ? 5 : -5
  await runPS(
    WIN32_TYPES +
    `[Win]::Scroll(${delta})`,
  )
}

// --- Template matching via Python (cv2) ---

const SCRIPT_DIR = join(process.cwd(), 'scripts')
const PY_FIND = join(SCRIPT_DIR, 'ig-find.py')

/** Run Python script via `py` launcher (Windows). */
function runPy(args: readonly string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('py', [PY_FIND, ...args], { timeout: timeoutMs, windowsHide: true, shell: false }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message))
      else resolve(stdout.trim())
    })
  })
}

export interface TemplateMatch {
  readonly x: number
  readonly y: number
  readonly confidence: number
}

/**
 * Find a template image on screen using OpenCV template matching.
 * Returns match coordinates or null if not found.
 */
export async function findOnScreen(templatePath: string, threshold = 0.7): Promise<TemplateMatch | null> {
  const output = await runPy([templatePath, String(threshold)])
  if (output === 'NOT_FOUND') return null
  if (output.startsWith('ERROR:')) throw new Error(output.slice(6))
  const parts = output.split(',')
  return {
    x: parseInt(parts[0], 10),
    y: parseInt(parts[1], 10),
    confidence: parseFloat(parts[2]),
  }
}

/** Capture full screen to a file (for sending to user). */
export async function captureScreenToFile(outputPath: string): Promise<{ width: number; height: number }> {
  const output = await runPy(['--capture', outputPath], 20_000)
  if (output.startsWith('ERROR:')) throw new Error(output.slice(6))
  const parts = output.replace('OK:', '').split(',')
  return { width: parseInt(parts[0], 10), height: parseInt(parts[1], 10) }
}
