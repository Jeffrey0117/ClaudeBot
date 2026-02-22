import { createBot } from './bot/bot.js'
import { env } from './config/env.js'
import { scanProjects } from './config/projects.js'

const MAX_RETRIES = 5

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function launchWithRetry(bot: ReturnType<typeof createBot>): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`Launching bot (attempt ${attempt})...`)

    // Race: launch vs 3s timeout
    // bot.launch() never resolves (infinite polling loop), but throws on 409/auth errors
    const result = await Promise.race([
      bot.launch({ dropPendingUpdates: true }).then(() => 'launched' as const),
      sleep(3000).then(() => 'timeout' as const),
    ]).catch((error) => error as Error)

    if (result === 'timeout') {
      // No error after 3s → bot is running (launch never resolves, that's normal)
      console.log('ClaudeBot is running! Press Ctrl+C to stop.')
      return
    }

    if (result instanceof Error) {
      const is409 = result.message.includes('409')
      if (is409 && attempt < MAX_RETRIES) {
        const delay = attempt * 3
        console.log(`409 conflict (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}s...`)
        await sleep(delay * 1000)
        continue
      }
      throw result
    }

    // 'launched' — shouldn't happen but handle it
    console.log('ClaudeBot is running! Press Ctrl+C to stop.')
    return
  }
}

async function main(): Promise<void> {
  console.log('Starting ClaudeBot...')

  const projects = scanProjects()
  console.log(`Found ${projects.length} projects in ${env.PROJECTS_BASE_DIR.join(', ')}`)
  projects.forEach((p) => console.log(`  - ${p.name}`))

  const bot = createBot()

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received. Shutting down...`)
    bot.stop(signal)
    process.exit(0)
  }

  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))

  await launchWithRetry(bot)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
