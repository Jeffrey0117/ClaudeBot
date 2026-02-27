#!/usr/bin/env node

// ClaudeBot CLI — zero-dependency scaffolder
// Downloads and sets up ClaudeBot from GitHub, or manages existing installs.
// Only uses Node.js built-in modules.

import { execSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, renameSync, readdirSync, copyFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { get as httpsGet } from 'node:https'
import { get as httpGet } from 'node:http'

const REPO_URL = 'https://github.com/Jeffrey0117/ClaudeBot'
const TARBALL_URL = `${REPO_URL}/archive/refs/heads/master.tar.gz`
const DEFAULT_DIR = join(homedir(), 'claudebot')

// ── Helpers ──────────────────────────────────────────────────────────────────

function bold(s) { return `\x1b[1m${s}\x1b[0m` }
function green(s) { return `\x1b[32m${s}\x1b[0m` }
function cyan(s) { return `\x1b[36m${s}\x1b[0m` }
function red(s) { return `\x1b[31m${s}\x1b[0m` }
function dim(s) { return `\x1b[2m${s}\x1b[0m` }

function ask(rl, question, fallback = '') {
  return new Promise((res) => {
    rl.question(question, (answer) => {
      res(answer.trim() || fallback)
    })
  })
}

function isValidInstall(dir) {
  return (
    existsSync(join(dir, 'package.json')) &&
    existsSync(join(dir, 'src', 'launcher.ts'))
  )
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', ...opts })
}

const ALLOWED_HOSTS = ['github.com', 'codeload.github.com', 'objects.githubusercontent.com']
const MAX_REDIRECTS = 5
const DOWNLOAD_TIMEOUT_MS = 60_000

function download(url, dest, redirects = 0) {
  if (redirects > MAX_REDIRECTS) {
    return Promise.reject(new Error('Too many redirects'))
  }
  return new Promise((res, rej) => {
    const getter = url.startsWith('https') ? httpsGet : httpGet
    const req = getter(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const loc = response.headers.location
        try {
          const host = new URL(loc, url).hostname
          if (!ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
            return rej(new Error(`Redirect to untrusted host: ${host}`))
          }
        } catch {
          return rej(new Error('Invalid redirect URL'))
        }
        return download(loc, dest, redirects + 1).then(res, rej)
      }
      if (response.statusCode !== 200) {
        return rej(new Error(`Download failed: HTTP ${response.statusCode}`))
      }
      const file = createWriteStream(dest)
      response.pipe(file)
      file.on('finish', () => file.close(res))
      file.on('error', rej)
    })
    req.on('error', rej)
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy()
      rej(new Error('Download timed out'))
    })
  })
}

function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

// ── Install ──────────────────────────────────────────────────────────────────

async function install(targetDir) {
  const tarball = join(targetDir, '.claudebot-download.tar.gz')

  console.log(`\n  ${cyan('Downloading ClaudeBot from GitHub...')}`)
  try {
    await download(TARBALL_URL, tarball)
  } catch (err) {
    rmSync(tarball, { force: true })
    console.error(`\n  ${red('Could not reach GitHub.')} ${err.message}`)
    process.exit(1)
  }

  console.log(`  ${cyan('Extracting...')}`)
  try {
    // tar extracts to ClaudeBot-master/ inside targetDir
    run(`tar -xzf "${tarball}" -C "${targetDir}"`, { stdio: 'pipe' })
  } catch {
    console.error(`\n  ${red('tar extraction failed.')}`)
    console.error(`  Windows 10 1803+ includes tar.exe. On older systems, install Git for Windows.`)
    process.exit(1)
  }

  // Move contents from ClaudeBot-master/ up to targetDir
  const extracted = join(targetDir, 'ClaudeBot-master')
  if (existsSync(extracted)) {
    for (const entry of readdirSync(extracted, { withFileTypes: true })) {
      const src = join(extracted, entry.name)
      const dest = join(targetDir, entry.name)
      if (existsSync(dest)) {
        // During update: skip existing user data, overwrite source files
        if (entry.isDirectory()) {
          copyDirRecursive(src, dest)
        } else {
          copyFileSync(src, dest)
        }
        rmSync(src, { recursive: true, force: true })
      } else {
        renameSync(src, dest)
      }
    }
    rmSync(extracted, { recursive: true, force: true })
  }

  // Clean up tarball
  rmSync(tarball, { force: true })
}

async function npmInstall(targetDir) {
  console.log(`  ${cyan('Installing dependencies...')}`)
  try {
    run('npm install', {
      cwd: targetDir,
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    })
  } catch {
    console.error(`\n  ${red('npm install failed.')}`)
    console.error(`  If bcrypt fails, install build tools:`)
    console.error(`    Windows: npm install -g windows-build-tools`)
    console.error(`    macOS:   xcode-select --install`)
    console.error(`    Linux:   sudo apt install build-essential python3`)
    process.exit(1)
  }
}

function runSetup(targetDir) {
  console.log()
  try {
    run('npx tsx src/setup.ts', { cwd: targetDir })
  } catch {
    console.log(`\n  ${dim('Setup wizard not available. You can configure .env manually.')}`)
  }
}

function startBot(targetDir) {
  console.log(`\n  ${green('Starting ClaudeBot...')}\n`)
  const child = spawn('npm', ['run', 'dev'], {
    cwd: targetDir,
    stdio: 'inherit',
    shell: true,
  })
  child.on('exit', (code) => process.exit(code ?? 0))
}

// ── Menu for existing install ────────────────────────────────────────────────

async function existingInstallMenu(rl, dir) {
  console.log(`\n  Found existing installation: ${bold(dir)}\n`)
  console.log(`  ${bold('1)')} Start bot`)
  console.log(`  ${bold('2)')} Update to latest`)
  console.log(`  ${bold('3)')} Re-run setup wizard`)
  console.log(`  ${bold('4)')} Show install path`)
  console.log()

  const choice = await ask(rl, `  Choose ${dim('(1)')}: `, '1')
  rl.close()

  switch (choice) {
    case '1':
      startBot(dir)
      break

    case '2':
      console.log(`\n  ${cyan('Updating ClaudeBot...')}`)
      console.log(`  ${dim('Your .env, data/, and .sessions.json are preserved.')}`)
      await install(dir)
      await npmInstall(dir)
      console.log(`\n  ${green('Updated successfully!')}`)
      break

    case '3':
      runSetup(dir)
      break

    case '4':
      console.log(`\n  ${bold('Install path:')} ${dir}`)
      break

    default:
      console.log(`\n  Unknown option: ${choice}`)
  }
}

// ── First-time install ───────────────────────────────────────────────────────

async function freshInstall(rl) {
  console.log(`\n  No existing installation found. Setting up ClaudeBot.\n`)

  const dirInput = await ask(
    rl,
    `  Install directory ${dim(`(${DEFAULT_DIR})`)}: `,
    DEFAULT_DIR
  )
  const targetDir = resolve(dirInput.replace(/^~/, homedir()))

  mkdirSync(targetDir, { recursive: true })

  await install(targetDir)
  await npmInstall(targetDir)
  runSetup(targetDir)

  console.log()
  const launch = await ask(rl, `  Start bot now? ${dim('(Y/n)')}: `, 'Y')
  rl.close()

  if (launch.toLowerCase() !== 'n') {
    startBot(targetDir)
  } else {
    console.log(`\n  To start later: ${cyan(`cd ${targetDir} && npm run dev`)}`)
  }
}

// ── Detect existing install ──────────────────────────────────────────────────

function findExistingInstall() {
  // Check current directory first
  if (isValidInstall(process.cwd())) return process.cwd()
  // Then check default location
  if (isValidInstall(DEFAULT_DIR)) return DEFAULT_DIR
  return null
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
  ${bold('ClaudeBot')} ${dim('— Telegram command center for Claude Code')}
  ${dim(REPO_URL)}`)

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  const existing = findExistingInstall()
  if (existing) {
    await existingInstallMenu(rl, existing)
  } else {
    await freshInstall(rl)
  }
}

main().catch((err) => {
  console.error(`\n  ${red('Error:')} ${err.message}`)
  process.exit(1)
})
