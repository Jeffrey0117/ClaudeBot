import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()

// Find all .env files: .env, .env.bot2, .env.bot3, ...
const envFiles = readdirSync(root)
  .filter((f) => f === '.env' || /^\.env\.bot\d+$/.test(f))
  .sort()

if (envFiles.length === 0) {
  console.error('No .env files found')
  process.exit(1)
}

// Single bot mode: --env flag passed directly
const singleEnv = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
const filesToLaunch = singleEnv ? [singleEnv] : envFiles

console.log(`Launching ${filesToLaunch.length} bot(s): ${filesToLaunch.join(', ')}`)

const tsxBin = path.join(root, 'node_modules', '.bin', 'tsx')
const indexPath = path.join(root, 'src', 'index.ts')

const children: ChildProcess[] = []

for (const envFile of filesToLaunch) {
  const label =
    envFile === '.env' ? 'main' : envFile.replace('.env.', '')

  const child = spawn(tsxBin, [indexPath, '--env', envFile], {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) console.log(`[${label}] ${line}`)
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) console.error(`[${label}] ${line}`)
    }
  })

  child.on('close', (code) => {
    console.log(`[${label}] exited (code ${code})`)
    // Remove from children array
    const idx = children.indexOf(child)
    if (idx !== -1) children.splice(idx, 1)
    // If all children exited, exit launcher
    if (children.length === 0) {
      console.log('All bots stopped.')
      process.exit(0)
    }
  })

  children.push(child)
}

// Graceful shutdown: forward signal to all children
const shutdown = (signal: string) => {
  console.log(`\n${signal} — stopping all bots...`)
  for (const child of children) {
    child.kill('SIGTERM')
  }
  // Force exit after 5s if children don't stop
  setTimeout(() => process.exit(0), 5000)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
