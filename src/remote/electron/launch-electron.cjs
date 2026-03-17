/**
 * Tiny CJS launcher for Electron.
 * Run with: node launch-electron.cjs [electron args...]
 *
 * - Resolves the real electron binary path from the electron package
 * - Spawns it detached with stderr → electron-launch.log
 * - Waits briefly to catch spawn errors before exiting
 */
const { spawn } = require('child_process')
const { join } = require('path')
const { openSync, closeSync, readFileSync, existsSync, mkdirSync } = require('fs')

const projectRoot = join(__dirname, '..', '..', '..')
const electronPkg = join(projectRoot, 'node_modules', 'electron')

// --- Resolve electron binary ---

if (!existsSync(electronPkg)) {
  console.error(`ERROR: electron package not found at ${electronPkg}`)
  console.error('Run: npm install electron')
  process.exit(1)
}

let electronBin
const pathFile = join(electronPkg, 'path.txt')
if (existsSync(pathFile)) {
  const relPath = readFileSync(pathFile, 'utf-8').trim()
  electronBin = join(electronPkg, 'dist', relPath)
} else {
  // Cross-platform fallback
  const binName = process.platform === 'win32' ? 'electron.exe'
    : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
    : 'electron'
  electronBin = join(electronPkg, 'dist', binName)
}

if (!existsSync(electronBin)) {
  console.error(`ERROR: electron binary not found at ${electronBin}`)
  console.error('The electron package may be corrupted. Try: rm -rf node_modules/electron && npm install electron')
  process.exit(1)
}

// --- Prepare log file ---

const dataDir = join(projectRoot, 'data')
mkdirSync(dataDir, { recursive: true })
const logPath = join(dataDir, 'electron-launch.log')
const logFd = openSync(logPath, 'w')

// --- Spawn Electron ---

const args = process.argv.slice(2)
console.log(`Binary: ${electronBin}`)
console.log(`Args: ${args.join(' ')}`)
console.log(`CWD: ${projectRoot}`)

let child
try {
  child = spawn(electronBin, args, {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', 'ignore', logFd],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: 'true' },
  })
} catch (err) {
  closeSync(logFd)
  console.error(`ERROR: Failed to spawn electron: ${err.message}`)
  process.exit(1)
}

// Wait 2s for spawn errors before declaring success
let exitedEarly = false

child.on('error', (err) => {
  exitedEarly = true
  console.error(`ERROR: Electron spawn failed: ${err.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (code !== null && code !== 0) {
    exitedEarly = true
    console.error(`ERROR: Electron exited immediately with code ${code} (signal: ${signal})`)
    console.error(`Check log: ${logPath}`)
    process.exit(1)
  }
})

setTimeout(() => {
  if (!exitedEarly) {
    child.unref()
    closeSync(logFd)
    console.log(`OK: Electron launched (pid ${child.pid})`)
    console.log(`Log: ${logPath}`)
    process.exit(0)
  }
}, 2000)
