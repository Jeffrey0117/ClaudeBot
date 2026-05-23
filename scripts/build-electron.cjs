/**
 * Build standalone Electron package.
 * Bundles main process + tool-handlers into a single CJS file,
 * copies preload script and renderer assets, generates ICO icon.
 *
 * Usage: node scripts/build-electron.cjs
 */
const { execSync } = require('child_process')
const { mkdirSync, copyFileSync, cpSync, existsSync, readFileSync, writeFileSync, rmSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const outDir = join(root, 'dist-electron')

// 1. Clean + create output directory
if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true })
}
mkdirSync(outDir, { recursive: true })

// 2. Bundle main process with esbuild (all deps inlined except electron)
console.log('[1/4] Bundling main process...')
execSync(
  [
    'npx esbuild src/remote/electron/main.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--outfile=dist-electron/main.cjs',
    '--external:electron',
  ].join(' '),
  { cwd: root, stdio: 'inherit' },
)

// 3. Copy preload script + renderer assets
console.log('[2/4] Copying preload + renderer assets...')
copyFileSync(
  join(root, 'src', 'remote', 'electron', 'preload.cjs'),
  join(outDir, 'preload.cjs'),
)
cpSync(
  join(root, 'src', 'remote', 'electron', 'renderer'),
  join(outDir, 'renderer'),
  { recursive: true },
)

// Copy icon to dist-electron for BrowserWindow icon
const pngSrc = join(root, 'claudebot-logo.png')
if (existsSync(pngSrc)) {
  copyFileSync(pngSrc, join(outDir, 'claudebot-logo.png'))
  console.log('  Copied claudebot-logo.png to dist-electron/')
}

// 4. Generate .ico from .png (PNG-in-ICO format)
console.log('[3/4] Generating icon...')
const pngPath = join(root, 'claudebot-logo.png')
const icoPath = join(root, 'claudebot-logo.ico')
if (existsSync(pngPath) && !existsSync(icoPath)) {
  const png = readFileSync(pngPath)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)   // reserved
  header.writeUInt16LE(1, 2)   // type = ICO
  header.writeUInt16LE(1, 4)   // count = 1
  const entry = Buffer.alloc(16)
  entry.writeUInt8(0, 0)       // width (0 = 256+)
  entry.writeUInt8(0, 1)       // height (0 = 256+)
  entry.writeUInt8(0, 2)       // color count
  entry.writeUInt8(0, 3)       // reserved
  entry.writeUInt16LE(1, 4)    // planes
  entry.writeUInt16LE(32, 6)   // bit count
  entry.writeUInt32LE(png.length, 8)  // size of PNG data
  entry.writeUInt32LE(22, 12)  // offset (6 + 16 = 22)
  writeFileSync(icoPath, Buffer.concat([header, entry, png]))
  console.log('  Created claudebot-logo.ico')
} else if (existsSync(icoPath)) {
  console.log('  claudebot-logo.ico already exists')
} else {
  console.log('  WARNING: claudebot-logo.png not found, skipping icon')
}

// 5. Fix winCodeSign cache (Windows symlink issue workaround)
if (process.platform === 'win32') {
  console.log('[4/4] Fixing winCodeSign cache...')
  const cacheDir = join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign')
  if (existsSync(cacheDir)) {
    const { readdirSync } = require('fs')
    const entries = readdirSync(cacheDir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory() && existsSync(join(cacheDir, e.name, 'rcedit-x64.exe'))) {
        // Found a valid extraction — create a marker so electron-builder finds it
        const darwinLib = join(cacheDir, e.name, 'darwin', '10.12', 'lib')
        mkdirSync(darwinLib, { recursive: true })
        // Create dummy files for the missing symlinks
        for (const lib of ['libcrypto.dylib', 'libssl.dylib']) {
          const libPath = join(darwinLib, lib)
          if (!existsSync(libPath)) {
            writeFileSync(libPath, '')
          }
        }
        console.log(`  Fixed cache: ${e.name}`)
      }
    }
  }
} else {
  console.log('[4/4] Skipping winCodeSign fix (not Windows)')
}

console.log('')
console.log('Build complete! Output: dist-electron/')
console.log('Next: npm run pack')
