/**
 * Build + sign the Windows exe with the local self-signed cert (.codesign/).
 * If the cert is absent, builds unsigned (so a clone without the cert still works).
 *   npm run pack:signed
 */
const { execSync } = require('child_process')
const { existsSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
execSync('node scripts/build-electron.cjs', { cwd: root, stdio: 'inherit' })

const pfx = join(root, '.codesign', 'codesign.pfx')
const env = { ...process.env }
if (existsSync(pfx)) {
  env.CSC_LINK = pfx
  env.CSC_KEY_PASSWORD = process.env.CSC_KEY_PASSWORD || 'claudebot'
  console.log(`[sign] signing with self-signed cert: ${pfx}`)
} else {
  console.log('[sign] no .codesign/codesign.pfx — building UNSIGNED (run scripts/setup-codesign.ps1 first to sign)')
}
execSync('npx electron-builder --win', { cwd: root, stdio: 'inherit', env })
