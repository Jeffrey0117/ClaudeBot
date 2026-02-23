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
import { promptCommand } from './commands/prompt.js'
import { runCommand } from './commands/run.js'
import { chatCommand } from './commands/chat.js'
import { messageHandler } from './handlers/message-handler.js'
import { callbackHandler } from './handlers/callback-handler.js'
import { photoHandler, documentHandler } from './handlers/photo-handler.js'
import { setupQueueProcessor } from './queue-processor.js'
import { setBotInstance } from './bio-updater.js'
import { loadPlugins, getLoadedPlugins } from '../plugins/loader.js'

export async function createBot(): Promise<Telegraf<BotContext>> {
  const bot = new Telegraf<BotContext>(env.BOT_TOKEN)

  // Middleware (order matters)
  bot.use(errorHandler())
  bot.use(dedupMiddleware())
  bot.use(rateLimitMiddleware())
  bot.use(authMiddleware())

  // Core commands
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
  bot.command('prompt', promptCommand)
  bot.command('run', runCommand)
  bot.command('chat', chatCommand)

  // Bookmark shortcuts /1 through /9
  for (let i = 1; i <= 9; i++) {
    bot.command(String(i), shortcutCommand)
  }

  // Load and register plugins
  const plugins = await loadPlugins(env.PLUGINS)
  for (const plugin of plugins) {
    for (const cmd of plugin.commands) {
      bot.command(cmd.name, cmd.handler)
    }
  }

  // Wire plugin-specific integrations
  const reminderPlugin = plugins.find((p) => p.name === 'reminder')
  if (reminderPlugin) {
    const { setReminderSendFn } = await import('../plugins/reminder/index.js')
    setReminderSendFn(async (chatId, text) => {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' })
    })
  }

  // Plugin message interceptors (before default handler)
  const pluginsWithMessage = plugins.filter((p) => p.onMessage)
  if (pluginsWithMessage.length > 0) {
    bot.on('text', async (ctx, next) => {
      for (const plugin of pluginsWithMessage) {
        const handled = await plugin.onMessage!(ctx)
        if (handled) return
      }
      return next()
    })
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

  // Store bot instance for bio updates
  setBotInstance(bot)

  // Register commands with Telegram for autocomplete (core + plugins)
  const coreCommands = [
    { command: 'projects', description: '瀏覽與選擇專案' },
    { command: 'select', description: '快速切換專案' },
    { command: 'model', description: '切換模型' },
    { command: 'status', description: '查看運行狀態' },
    { command: 'cancel', description: '停止目前程序' },
    { command: 'new', description: '新對話' },
    { command: 'fav', description: '管理書籤' },
    { command: 'todo', description: '新增待辦' },
    { command: 'todos', description: '查看待辦' },
    { command: 'run', description: '跨專案執行' },
    { command: 'chat', description: '通用對話模式' },
    { command: 'help', description: '顯示說明' },
  ]

  const pluginCommands = plugins.flatMap((p) =>
    p.commands.map((cmd) => ({ command: cmd.name, description: cmd.description }))
  )

  bot.telegram.setMyCommands([...coreCommands, ...pluginCommands]).catch(() => {})

  return bot
}
