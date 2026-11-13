import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/** Settings the desktop client remembers between runs (`electron-config.json`). */
export interface ElectronConfig {
  readonly projectsBaseDir?: string
  readonly licenseKey?: string
  readonly relayUrl?: string
  readonly discoveryUrl?: string
  readonly relayPasteId?: string
  /** Last version we offered an update for, so we ask once per version. */
  readonly lastNotifiedVersion?: string
}

export interface ElectronConfigStore {
  readonly load: () => ElectronConfig
  /** Merge `patch` into the stored config and return the result. */
  readonly save: (patch: Partial<ElectronConfig>) => ElectronConfig
}

/** Config store kept in `dataDir`. A missing or unreadable file reads as empty. */
export function createElectronConfigStore(dataDir: string): ElectronConfigStore {
  const configPath = resolve(dataDir, 'electron-config.json')

  const load = (): ElectronConfig => {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8')) as ElectronConfig
    } catch {
      return {}
    }
  }

  const save = (patch: Partial<ElectronConfig>): ElectronConfig => {
    const updated = { ...load(), ...patch }
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf-8')
    return updated
  }

  return { load, save }
}
