import { createBot } from './bot/bot.js'
import { env } from './config/env.js'
import { scanProjects } from './config/projects.js'

async function main(): Promise<void> {
  console.log('Starting ClaudeBot...')

  // Validate projects directory
  const projects = scanProjects()
  console.log(`Found ${projects.length} projects in ${env.PROJECTS_BASE_DIR}`)
  projects.forEach((p) => console.log(`  - ${p.name}`))

  // Create and launch bot
  const bot = createBot()

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(`\n${signal} received. Shutting down...`)
    bot.stop(signal)
    process.exit(0)
  }

  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))

  // Start polling
  await bot.launch()
  console.log('ClaudeBot is running! Press Ctrl+C to stop.')
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
