/** Bypass npx — spawn electron.exe directly. Usage: node run-electron.cjs [args...] */
const { spawn } = require('child_process')
const { join, resolve } = require('path')
const { readFileSync } = require('fs')

const root = resolve(__dirname)
const relPath = readFileSync(join(root, 'node_modules', 'electron', 'path.txt'), 'utf-8').trim()
const bin = join(root, 'node_modules', 'electron', 'dist', relPath)

const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
