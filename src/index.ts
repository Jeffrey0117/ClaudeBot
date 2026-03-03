import { createBot } from './bot/bot.js'
import { env } from './config/env.js'
import { scanProjects } from './config/projects.js'
import { startDashboardServer } from './dashboard/server.js'
import { startRelayServer } from './remote/relay-server.js'
import { syncWorktreeOnStartup } from './git/worktree-sync.js'

// P0: Catch unhandled errors — heartbeat keeps writing so watchdog can decide
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection:', reason)
  // Don't exit — may be recoverable. If bot is truly dead, heartbeat stalls
  // and launcher watchdog will kill + respawn.
})

process.on('uncaughtException', (error) => {
  console.error('[fatal] Uncaught exception:', error)
  // Stack may be corrupted — exit immediately, let launcher respawn
  process.exit(1)
})

const MAX_RETRIES = 5

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  console.log('Starting ClaudeBot...')

  // Auto-sync worktree branch with master on startup
  syncWorktreeOnStartup()

  const projects = scanProjects()
  console.log(`Found ${projects.length} projects in ${env.PROJECTS_BASE_DIR.join(', ')}`)
  projects.forEach((p) => console.log(`  - ${p.name}`))

  const bot = await createBot()

  // Start dashboard server in-process (main bot only) for response broker events
  const envArg = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
  const isMainBot = !envArg || envArg === '.env'
  if (env.DASHBOARD && isMainBot) {
    startDashboardServer(env.DASHBOARD_PORT)
  }

  // Start relay server for remote vibe-coding pairing
  if (isMainBot) {
    startRelayServer(env.RELAY_PORT)
  }

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
    let launched = false
    bot.launch({ dropPendingUpdates: true }).catch((error: Error) => {
      if (launched) {
        // Error AFTER the 3s check window — wait for Telegram to release
        // the polling session before exiting (prevents cascading 409 on respawn)
        const is409 = error.message.includes('409')
        const delay = is409 ? 10_000 : 0
        console.error(`Polling crashed after startup: ${error.message}${is409 ? ' (waiting 10s for session release)' : ''}`)
        setTimeout(() => process.exit(1), delay)
        return
      }
      launchFailed = true
      launchError = error
    })

    // Wait to detect immediate failures (409, auth errors)
    await sleep(3000)

    if (!launchFailed) {
      launched = true
      console.log('ClaudeBot is running! Press Ctrl+C to stop.')
      return
    }

    // Handle failure
    const is409 = (launchError as Error | null)?.message.includes('409')
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
