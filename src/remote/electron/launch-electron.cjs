/**
 * Tiny CJS launcher for Electron.
 * Run with: node launch-electron.cjs [electron args...]
 *
 * - Resolves the real electron.exe path from the electron package
 * - Spawns it detached with stderr → electron-error.log
 * - Exits immediately so the caller (remote agent) is not blocked
 */
const { spawn } = require('child_process')
const { join } = require('path')
const { openSync, closeSync, readFileSync, existsSync } = require('fs')

const projectRoot = join(__dirname, '..', '..', '..')
const electronPkg = join(projectRoot, 'node_modules', 'electron')

// Resolve electron binary path the same way the electron package does
let electronBin
const pathFile = join(electronPkg, 'path.txt')
if (existsSync(pathFile)) {
  const relPath = readFileSync(pathFile, 'utf-8').trim()
  electronBin = join(electronPkg, 'dist', relPath)
} else {
  // Fallback
  electronBin = join(electronPkg, 'dist', 'electron.exe')
}

// Forward all args after this script to Electron
const args = process.argv.slice(2)

// Open a log file for stderr so we can debug crashes
const logPath = join(projectRoot, 'data', 'electron-launch.log')
const logFd = openSync(logPath, 'w')

const child = spawn(electronBin, args, {
  cwd: projectRoot,
  detached: true,
  stdio: ['ignore', 'ignore', logFd],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: 'true' },
})

child.unref()
closeSync(logFd)

// eslint-disable-next-line no-console
console.log(`Launched electron (pid ${child.pid}), log: ${logPath}`)
process.exit(0)
