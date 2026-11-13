import { describe, it, expect } from 'vitest'
import { botIdFromEnvFile, envFileFromArgv, deriveBotId, isSecondaryBot } from '../../src/config/bot-id.js'

describe('bot identity', () => {
  it('names the main bot bot1 and the others after their env file', () => {
    expect(botIdFromEnvFile('.env')).toBe('bot1')
    expect(botIdFromEnvFile('.env.bot2')).toBe('bot2')
    expect(botIdFromEnvFile('.env.bot15')).toBe('bot15')
  })

  it('treats a missing env file as the main bot', () => {
    expect(botIdFromEnvFile(undefined)).toBe('bot1')
    expect(botIdFromEnvFile('')).toBe('bot1')
  })

  it('reads the env file from --env', () => {
    expect(envFileFromArgv(['node', 'index.ts'])).toBeUndefined()
    expect(envFileFromArgv(['node', 'index.ts', '--env', '.env.bot3'])).toBe('.env.bot3')
    expect(envFileFromArgv(['node', 'index.ts', '--env'])).toBeUndefined()
  })

  it('derives the id of the running process the same way the launcher names it', () => {
    // The launcher and the bot must agree, or the watchdog reads a heartbeat
    // file that is never written (this happened: 'main' vs 'bot1').
    for (const envFile of ['.env', '.env.bot2', '.env.bot7']) {
      expect(deriveBotId(['node', 'index.ts', '--env', envFile])).toBe(botIdFromEnvFile(envFile))
    }
    expect(deriveBotId(['node', 'index.ts'])).toBe('bot1')
  })

  it('knows which bots are secondary', () => {
    expect(isSecondaryBot(['node', 'index.ts'])).toBe(false)
    expect(isSecondaryBot(['node', 'index.ts', '--env', '.env'])).toBe(false)
    expect(isSecondaryBot(['node', 'index.ts', '--env', '.env.bot3'])).toBe(true)
  })
})
