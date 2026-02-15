import { Telegraf } from 'telegraf'
import { env } from '../config/env.js'
import type { BotContext } from '../types/context.js'
import { errorHandler } from './middleware/error-handler.js'
import { dedupMiddleware } from './middleware/dedup.js'
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
import { favCommand } from './commands/fav.js'
import { shortcutCommand } from './commands/shortcut.js'
import { todoCommand, todosCommand } from './commands/todo.js'
import { mkdirCommand } from './commands/mkdir.js'
import { cdCommand } from './commands/cd.js'
import { screenshotCommand } from './commands/screenshot.js'
import { promptCommand } from './commands/prompt.js'
import { messageHandler } from './handlers/message-handler.js'
import { callbackHandler } from './handlers/callback-handler.js'
import { photoHandler, documentHandler } from './handlers/photo-handler.js'
import { setupQueueProcessor } from './queue-processor.js'

export function createBot(): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(env.BOT_TOKEN)

  // Middleware (order matters)
  bot.use(errorHandler())
  bot.use(dedupMiddleware())
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
  bot.command('fav', favCommand)
  bot.command('todo', todoCommand)
  bot.command('todos', todosCommand)
  bot.command('mkdir', mkdirCommand)
  bot.command('cd', cdCommand)
  bot.command('screenshot', screenshotCommand)
  bot.command('prompt', promptCommand)

  // Bookmark shortcuts /1 through /9
  for (let i = 1; i <= 9; i++) {
    bot.command(String(i), shortcutCommand)
  }

  // Callback queries (inline keyboard)
  bot.on('callback_query', callbackHandler)

  // Photo and document messages → Claude
  bot.on('photo', photoHandler)
  bot.on('document', documentHandler)

  // Text messages → Claude
  bot.on('text', messageHandler)

  // Set up the queue processor
  setupQueueProcessor(bot)

  return bot
}
