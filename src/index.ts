import { createBot } from './bot/bot.js'
import { env } from './config/env.js'
import { scanProjects } from './config/projects.js'

const MAX_RETRIES = 5

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  // Keep event loop alive (polling HTTP requests alone may not suffice)
  setInterval(() => {}, 60_000)

  // Launch with retry on 409
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`Launching bot (attempt ${attempt})...`)

    let launchFailed = false
    let launchError: Error | null = null

    // Fire-and-forget: bot.launch() never resolves (infinite polling loop)
    bot.launch({ dropPendingUpdates: true }).catch((error: Error) => {
      launchFailed = true
      launchError = error
    })

    // Wait to detect immediate failures (409, auth errors)
    await sleep(3000)

    if (!launchFailed) {
      console.log('ClaudeBot is running! Press Ctrl+C to stop.')
      return
    }

    // Handle failure
    const is409 = launchError?.message.includes('409')
    if (is409 && attempt < MAX_RETRIES) {
      const delay = attempt * 3
      console.log(`409 conflict (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}s...`)
      await sleep(delay * 1000)
      continue
    }

    throw launchError
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
