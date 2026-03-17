/** Bypass npx — spawn electron.exe directly. Usage: node run-electron.cjs [args...] */
const { spawn } = require('child_process')
const { join, resolve } = require('path')
const { readFileSync, existsSync } = require('fs')

const root = resolve(__dirname)
const pathFile = join(root, 'node_modules', 'electron', 'path.txt')

if (!existsSync(pathFile)) {
  console.error('ERROR: electron not installed. Run: npm install')
  process.exit(1)
}

const relPath = readFileSync(pathFile, 'utf-8').trim()
const bin = join(root, 'node_modules', 'electron', 'dist', relPath)
const args = process.argv.slice(2)

console.log(`Electron: ${bin}`)
console.log(`Args: ${args.join(' ')}`)

const child = spawn(bin, args, {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
})

child.stdout.on('data', (d) => process.stdout.write(d))
child.stderr.on('data', (d) => process.stderr.write(d))
child.on('error', (err) => {
  console.error(`ERROR: ${err.message}`)
  process.exit(1)
})
child.on('exit', (code) => {
  if (code && code !== 0) console.error(`Electron exited (code ${code})`)
  process.exit(code ?? 0)
})
