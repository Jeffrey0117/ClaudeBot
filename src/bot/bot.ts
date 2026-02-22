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

  // Register commands with Telegram for autocomplete
  bot.telegram.setMyCommands([
    { command: 'projects', description: '\u{700F}\u{89BD}\u{8207}\u{9078}\u{64C7}\u{5C08}\u{6848}' },
    { command: 'select', description: '\u{5FEB}\u{901F}\u{5207}\u{63DB}\u{5C08}\u{6848}' },
    { command: 'model', description: '\u{5207}\u{63DB}\u{6A21}\u{578B}' },
    { command: 'status', description: '\u{67E5}\u{770B}\u{904B}\u{884C}\u{72C0}\u{614B}' },
    { command: 'cancel', description: '\u{505C}\u{6B62}\u{76EE}\u{524D}\u{7A0B}\u{5E8F}' },
    { command: 'new', description: '\u{65B0}\u{5C0D}\u{8A71}' },
    { command: 'fav', description: '\u{7BA1}\u{7406}\u{66F8}\u{7C64}' },
    { command: 'todo', description: '\u{65B0}\u{589E}\u{5F85}\u{8FA6}' },
    { command: 'todos', description: '\u{67E5}\u{770B}\u{5F85}\u{8FA6}' },
    { command: 'screenshot', description: '\u{622A}\u{53D6}\u{756B}\u{9762}' },
    { command: 'help', description: '\u{986F}\u{793A}\u{8AAA}\u{660E}' },
  ]).catch(() => {})

  return bot
}
