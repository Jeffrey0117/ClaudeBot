import { readFileSync } from 'node:fs'
import path from 'node:path'
import { env } from '../../config/env.js'

/**
 * Resolved connection settings for the bat-remote backend.
 *
 * Two sources, env first: the host machine running BAT sets BAT_REMOTE_* in its
 * env; a machine that was paired via `/pair bat` + `join-bat` instead reads the
 * credential pack from data/bat-remote.json. Same driver code, either way.
 */
export interface BatRemoteConfig {
  readonly url: string
  readonly token: string
  readonly fingerprint: string
  readonly cwd?: string
  readonly source: 'env' | 'file'
}

const STORE_PATH = path.resolve('data', 'bat-remote.json')

export function loadBatRemoteConfig(): BatRemoteConfig | null {
  if (env.BAT_REMOTE_URL && env.BAT_REMOTE_TOKEN && env.BAT_REMOTE_FINGERPRINT) {
    return {
      url: env.BAT_REMOTE_URL,
      token: env.BAT_REMOTE_TOKEN,
      fingerprint: env.BAT_REMOTE_FINGERPRINT,
      ...(env.BAT_REMOTE_CWD ? { cwd: env.BAT_REMOTE_CWD } : {}),
      source: 'env',
    }
  }

  try {
    const raw = readFileSync(STORE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const url = typeof parsed.url === 'string' ? parsed.url : ''
    const token = typeof parsed.token === 'string' ? parsed.token : ''
    const fingerprint = typeof parsed.fingerprint === 'string' ? parsed.fingerprint : ''
    if (!url || !token || !fingerprint) return null
    const cwd = typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : undefined
    return { url, token, fingerprint, ...(cwd ? { cwd } : {}), source: 'file' }
  } catch {
    return null
  }
}
