/**
 * Electron diagnostic — run on remote: node test-electron.cjs
 * Checks every possible failure point.
 */
const { existsSync, readFileSync, statSync } = require('fs')
const { join } = require('path')
const { execSync, spawnSync } = require('child_process')

const root = process.cwd()
const ok = (msg) => console.log(`  OK  ${msg}`)
const fail = (msg) => console.log(`  FAIL  ${msg}`)
const info = (msg) => console.log(`  ---  ${msg}`)

console.log('\n=== Electron Diagnostic ===\n')
console.log(`CWD: ${root}`)
console.log(`Platform: ${process.platform} ${process.arch}`)
console.log(`Node: ${process.version}\n`)

// 1. Check node_modules/electron
const electronPkg = join(root, 'node_modules', 'electron')
const electronExists = existsSync(electronPkg)
electronExists ? ok('node_modules/electron exists') : fail('node_modules/electron MISSING — run: npm install')

if (!electronExists) {
  console.log('\n  electron not installed. It is in devDependencies.')
  console.log('  Fix: npm install   (without --production or --omit=dev)\n')
  process.exit(1)
}

// 2. Check electron binary
const pathFile = join(electronPkg, 'path.txt')
let electronBin = ''
if (existsSync(pathFile)) {
  const relPath = readFileSync(pathFile, 'utf-8').trim()
  electronBin = join(electronPkg, 'dist', relPath)
  ok(`path.txt says: ${relPath}`)
} else {
  fail('path.txt missing — electron package corrupted')
  console.log('  Fix: rm -rf node_modules/electron && npm install electron\n')
  process.exit(1)
}

if (existsSync(electronBin)) {
  const stat = statSync(electronBin)
  ok(`binary exists: ${electronBin} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
} else {
  fail(`binary NOT FOUND: ${electronBin}`)
  console.log('  Fix: rm -rf node_modules/electron && npm install electron\n')
  process.exit(1)
}

// 3. Try electron --version
try {
  const ver = spawnSync(electronBin, ['--version'], { timeout: 15000, windowsHide: true })
  if (ver.status === 0) {
    ok(`electron --version: ${ver.stdout.toString().trim()}`)
  } else {
    const stderr = ver.stderr?.toString().trim() || '(no stderr)'
    fail(`electron --version exited ${ver.status}: ${stderr}`)
  }
} catch (err) {
  fail(`electron --version threw: ${err.message}`)
}

// 4. Try loading main.cjs in node (not electron) to check for syntax/require errors
const mainCjs = join(root, 'dist', 'remote', 'electron', 'main.cjs')
if (existsSync(mainCjs)) {
  ok(`main.cjs exists (${(statSync(mainCjs).size / 1024).toFixed(0)} KB)`)

  // Quick syntax check — try to parse it
  try {
    const code = readFileSync(mainCjs, 'utf-8')
    new Function(code)  // syntax check only
    ok('main.cjs syntax OK')
  } catch (err) {
    fail(`main.cjs syntax error: ${err.message}`)
  }
} else {
  fail('main.cjs MISSING — run: npm run build')
}

// 5. Check static assets
const checks = [
  ['preload.cjs (dist)', join(root, 'dist', 'remote', 'electron', 'preload.cjs')],
  ['preload.cjs (src)', join(root, 'src', 'remote', 'electron', 'preload.cjs')],
  ['chat.html (dist)', join(root, 'dist', 'remote', 'electron', 'renderer', 'chat.html')],
  ['chat.html (src)', join(root, 'src', 'remote', 'electron', 'renderer', 'chat.html')],
  ['chat.css (dist)', join(root, 'dist', 'remote', 'electron', 'renderer', 'chat.css')],
  ['chat-renderer.js (dist)', join(root, 'dist', 'remote', 'electron', 'renderer', 'chat-renderer.js')],
]
console.log('')
for (const [label, p] of checks) {
  existsSync(p) ? ok(label) : fail(label)
}

// 6. Try actually spawning electron with a temp script file (not -e, which Electron may not support)
console.log('\n--- Spawning electron with minimal test script (GPU disabled) ---\n')
const tmpScript = join(root, 'data', '_electron_test.cjs')
require('fs').writeFileSync(tmpScript, `
  const { app } = require('electron');
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  app.whenReady().then(() => {
    process.stdout.write('ELECTRON_OK');
    app.quit();
  });
  setTimeout(() => { process.stdout.write('ELECTRON_TIMEOUT'); app.quit(); }, 10000);
`, 'utf-8')
const testResult = spawnSync(electronBin, [tmpScript], {
  timeout: 20000,
  windowsHide: false,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: 'true' },
})
try { require('fs').unlinkSync(tmpScript) } catch {}

const testOut = testResult.stdout?.toString().trim() || ''
const testErr = testResult.stderr?.toString().trim() || ''

if (testOut.includes('ELECTRON_OK')) {
  ok('Electron can start and create app!')
} else if (testOut.includes('ELECTRON_TIMEOUT')) {
  fail('Electron started but app.whenReady() never fired')
} else {
  fail(`Electron test failed (exit ${testResult.status})`)
  if (testOut) info(`stdout: ${testOut.slice(0, 500)}`)
  if (testErr) info(`stderr: ${testErr.slice(0, 500)}`)
  if (!testOut && !testErr) info('(zero output — binary may be broken or missing system libs)')
}

console.log('\n=== Done ===\n')
