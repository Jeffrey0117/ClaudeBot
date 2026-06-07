import { createHash } from 'node:crypto'

export interface FingerprintParts {
  readonly model: string
  readonly pairingCode: string | null
  readonly isAdmin: boolean
  readonly browser: boolean
  readonly systemPromptVersion: number
}

/** Hash of all launch-time-bound config. A change requires a session restart. */
export function computeFingerprint(p: FingerprintParts): string {
  const canonical = [
    p.model, p.pairingCode ?? '', p.isAdmin ? '1' : '0', p.browser ? '1' : '0', String(p.systemPromptVersion),
  ].join('|')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}
