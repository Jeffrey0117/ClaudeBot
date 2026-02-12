import { Telegraf } from 'telegraf'
import { env } from '../config/env.js'
import type { BotContext } from '../types/context.js'
import { errorHandler } from './middleware/error-handler.js'
import { authMiddleware } from './middleware/auth.js'
import { rateLimitMiddleware } from './middleware/rate-limit.js'
import { startCommand } from './commands/start.js'
import { loginCommand } from './commands/login.js'
import { logoutCommand } from './commands/logout.js'
import { projectsCommand } from './commands/projects.js'
import { selectCommand } from './commands/select.js'
import { statusCommand } from './commands/status.js'
import { cancelCommand } from './commands/cancel.js'
import { modelCommand } from './commands/model.js'
import { helpCommand } from './commands/help.js'
import { newSessionCommand } from './commands/new-session.js'
import { messageHandler } from './handlers/message-handler.js'
import { callbackHandler } from './handlers/callback-handler.js'
import { setupQueueProcessor } from './queue-processor.js'

export function createBot(): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(env.BOT_TOKEN)

  // Middleware (order matters)
  bot.use(errorHandler())
  bot.use(rateLimitMiddleware())
  bot.use(authMiddleware())

  // Commands
  bot.command('start', startCommand)
  bot.command('login', loginCommand)
  bot.command('logout', logoutCommand)
  bot.command('projects', projectsCommand)
  bot.command('select', selectCommand)
  bot.command('status', statusCommand)
  bot.command('cancel', cancelCommand)
  bot.command('model', modelCommand)
  bot.command('help', helpCommand)
  bot.command('new', newSessionCommand)

  // Callback queries (inline keyboard)
  bot.on('callback_query', callbackHandler)

  // Text messages → Claude
  bot.on('text', messageHandler)

  // Set up the queue processor
  setupQueueProcessor(bot)

  return bot
}
