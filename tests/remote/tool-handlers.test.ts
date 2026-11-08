import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { isDangerousCommand } from '../../src/remote/tool-handlers/dangerous-commands.js'

/**
 * This whole directory was unimportable in ESM.
 *
 * index.ts declared the shared constants AND imported every tool module, while
 * those modules imported the constants back from './index.js'. Importing
 * index.js evaluates its dependencies first, so file-tools' top-level
 * `const SYSTEM_PATHS = IS_WIN ? ... : ...` read a binding still in its
 * temporal dead zone and threw. src/remote/agent.ts imports the dispatcher
 * statically, so the remote agent could not start and every remote tool was
 * dead at the agent end.
 */
const TOOL_DIR = resolve('src/remote/tool-handlers')

describe('tool-handlers module graph', () => {
  // NOTE: a plain `await import(...)` here does NOT catch this. vitest
  // transforms modules with esbuild, whose wrapper yields undefined rather
  // than a TDZ error on a circular const — so such a test passes against both
  // the broken and the fixed shape, which is worse than no test. The rule is
  // asserted structurally instead, and separately under real node ESM.
  it('no tool module imports the shared constants back from index.js', () => {
    const offenders: string[] = []
    for (const name of readdirSync(TOOL_DIR)) {
      if (!name.endsWith('.ts') || name === 'index.ts') continue
      const src = readFileSync(join(TOOL_DIR, name), 'utf-8')
      // Real import statements only — prose mentioning './index.js' is fine.
      if (/^\s*import[^\n]*from '\.\/index\.js'/m.test(src)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  it('declares the shared constants in a leaf module with no local imports', () => {
    const src = readFileSync(join(TOOL_DIR, 'constants.ts'), 'utf-8')
    expect(src).toMatch(/export const IS_WIN/)
    expect(src).not.toMatch(/^import .* from '\.\//m)
  })

  it('index.js imports cleanly under real node ESM', () => {
    const built = resolve('dist/remote/tool-handlers/index.js')
    if (!existsSync(built)) return // only meaningful after a build
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        // Windows absolute paths must be file:// URLs for dynamic import
        `import(${JSON.stringify(pathToFileURL(built).href)})` +
          `.then((m) => console.log('OK:' + typeof m.createToolDispatcher))` +
          `.catch((e) => { console.log('ERR:' + e.message); process.exitCode = 1 })`,
      ],
      { encoding: 'utf-8' },
    )
    expect(out.trim()).toBe('OK:function')
  })
})

/**
 * remote_spawn_detached received baseDir instead of validatePath and never
 * consulted this blacklist, so anything remote_execute_command rejected ran
 * fine there the moment it contained shell metacharacters.
 */
describe('dangerous command blacklist', () => {
  it('allows ordinary dev commands', () => {
    for (const cmd of ['npx vite', 'node main.js', 'npm run dev', 'git status']) {
      expect(isDangerousCommand(cmd), cmd).toBeNull()
    }
  })

  it('blocks destructive commands', () => {
    for (const cmd of [
      'rm -rf /',
      'rd /s /q C:/Users/x/Desktop',
      'del /f /s /q C:/Users/x',
      'shutdown /s',
      'diskpart',
    ]) {
      expect(isDangerousCommand(cmd), cmd).not.toBeNull()
    }
  })

  it('blocks the shell-wrapped forms that bypassed it via spawn_detached', () => {
    for (const cmd of [
      'cmd /c rd /s /q C:/Users/x/Desktop',
      'cmd /c del /f /s /q C:/Users/x',
      'cmd /c shutdown /r',
    ]) {
      expect(isDangerousCommand(cmd), cmd).not.toBeNull()
    }
  })

  it('still blocks the node/electron kill patterns the project forbids', () => {
    expect(isDangerousCommand('taskkill /F /IM node.exe')).not.toBeNull()
    expect(isDangerousCommand('pkill node')).not.toBeNull()
    expect(isDangerousCommand('Stop-Process -Name electron')).not.toBeNull()
  })
})
