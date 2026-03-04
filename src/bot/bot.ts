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
import { ideaCommand, ideasCommand } from './commands/idea.js'
import { mkdirCommand } from './commands/mkdir.js'
import { cdCommand } from './commands/cd.js'
import { promptCommand } from './commands/prompt.js'
import { runCommand } from './commands/run.js'
import { chatCommand } from './commands/chat.js'
import { restartCommand, handleRestartCallback } from './commands/restart.js'
import { newbotCommand } from './commands/newbot.js'
import { reloadCommand } from './commands/reload.js'
import { contextCommand } from './commands/context.js'
import { asrCommand } from './commands/asr.js'
import { storeCommand } from './commands/store.js'
import { installCommand } from './commands/install.js'
import { uninstallCommand } from './commands/uninstall.js'
import { deployCommand } from './commands/deploy.js'
import { syncCommand } from './commands/sync.js'
import { pairCommand, unpairCommand } from './commands/pair.js'
import { rpairCommand } from './commands/rpair.js'
import { grabCommand } from './commands/grab.js'
import { claudemdCommand } from './commands/claudemd.js'
import { rstatusCommand } from './commands/rstatus.js'
import { rlogCommand } from './commands/rlog.js'
import { parallelCommand } from './commands/parallel.js'
import { ctxCommand } from './commands/ctx.js'
import { deepCommand } from './commands/deep.js'
import { messageHandler } from './handlers/message-handler.js'
import { callbackHandler } from './handlers/callback-handler.js'
import { photoHandler, documentHandler } from './handlers/photo-handler.js'
import { voiceHandler } from './handlers/voice-handler.js'
import { warmupSherpa, addHotwords, isSherpaAvailable } from '../asr/sherpa-client.js'
import { scanProjects } from '../config/projects.js'
import { setupQueueProcessor } from './queue-processor.js'
import { setBotInstance } from './bio-updater.js'
import {
  loadPlugins,
  getPluginModule,
  discoverAllPluginCommandNames,
  isPluginCommand,
  dispatchPluginCommand,
  dispatchPluginMessage,
  dispatchPluginCallback,
} from '../plugins/loader.js'
import { getEnabledPlugins } from '../plugins/plugin-manager.js'
import { startHeartbeat } from '../dashboard/heartbeat-writer.js'
import { startCommandReader } from '../dashboard/command-reader.js'
import { setAvailableCommands } from '../utils/system-prompt.js'
import { scheduleRestartNotifications } from './restart-notifier.js'
import { onPairingConnect, onPairingDisconnect } from '../remote/pairing-store.js'

let botInstance: Telegraf<BotContext> | null = null

export function getBotInstance(): Telegraf<BotContext> | null {
  return botInstance
}

// Registry of core command handlers for programmatic dispatch (e.g. @cmd directives)
const coreHandlers = new Map<string, (ctx: BotContext) => Promise<void>>()

export function getCoreCommandHandler(name: string): ((ctx: BotContext) => Promise<void>) | undefined {
  return coreHandlers.get(name)
}

export const CORE_COMMANDS = [
  { command: 'projects', description: '瀏覽與選擇專案' },
  { command: 'select', description: '快速切換專案' },
  { command: 'model', description: '切換模型' },
  { command: 'status', description: '查看運行狀態' },
  { command: 'cancel', description: '停止目前程序' },
  { command: 'new', description: '新對話' },
  { command: 'fav', description: '管理書籤 (list/add/del)' },
  { command: 'todo', description: '新增待辦 (文字)' },
  { command: 'todos', description: '查看待辦 (all=全專案)' },
  { command: 'idea', description: '記錄靈感 (#tag)' },
  { command: 'ideas', description: '瀏覽靈感 (#tag/stats)' },
  { command: 'run', description: '跨專案執行 (專案名 指令)' },
  { command: 'chat', description: '通用對話模式' },
  { command: 'newbot', description: '建立新 bot 實例' },
  { command: 'store', description: 'Plugin Store 瀏覽' },
  { command: 'install', description: '安裝插件 (名稱)' },
  { command: 'uninstall', description: '卸載插件 (名稱)' },
  { command: 'reload', description: '熱重載插件' },
  { command: 'asr', description: '語音轉文字 (on/off)' },
  { command: 'context', description: '上下文管理 (pin/list/clear)' },
  { command: 'restart', description: '重啟 Bot (all=全部)' },
  { command: 'deploy', description: '部署專案 (commit + push)' },
  { command: 'sync', description: '同步所有 worktree' },
  { command: 'pair', description: '配對遠端電腦 (code@ip:port)' },
  { command: 'unpair', description: '斷開遠端配對' },
  { command: 'rpair', description: '重啟遠端 agent' },
  { command: 'grab', description: '從遠端下載檔案' },
  { command: 'claudemd', description: '自動生成/更新 CLAUDE.md' },
  { command: 'rstatus', description: '查看遠端系統狀態' },
  { command: 'rlog', description: '查看遠端 log' },
  { command: 'parallel', description: '平行執行多個任務' },
  { command: 'ctx', description: '查看/管理上下文摘要' },
  { command: 'deep', description: '深度分析 (opus + subagent)' },
  { command: 'help', description: '顯示說明' },
] as const

export function wireReminderSendFn(bot: Telegraf<BotContext>): void {
  const mod = getPluginModule('reminder')
  if (!mod || typeof mod.setReminderSendFn !== 'function') return
  ;(mod.setReminderSendFn as (fn: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<void>) => void)(
    async (chatId, text, extra) => {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra })
    }
  )
}

export function wireSchedulerSendFn(bot: Telegraf<BotContext>): void {
  const mod = getPluginModule('scheduler')
  if (!mod || typeof mod.setSchedulerSendFn !== 'function') return
  ;(mod.setSchedulerSendFn as (fn: (chatId: number, text: string, extra?: { parse_mode?: 'Markdown' }) => Promise<void>) => void)(
    async (chatId, text, extra) => {
      await bot.telegram.sendMessage(chatId, text, { ...extra })
    }
  )
}

export function wireTaskSendFn(bot: Telegraf<BotContext>): void {
  const mod = getPluginModule('task')
  if (!mod || typeof mod.setTaskSendFn !== 'function') return
  ;(mod.setTaskSendFn as (fn: (chatId: number, text: string, extra?: Record<string, unknown>) => Promise<void>) => void)(
    async (chatId, text, extra) => {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra })
    }
  )
}

export async function createBot(): Promise<Telegraf<BotContext>> {
  const telegrafOptions = env.TELEGRAM_API_BASE
    ? { telegram: { apiRoot: env.TELEGRAM_API_BASE } }
    : {}
  const bot = new Telegraf<BotContext>(env.BOT_TOKEN, telegrafOptions)

  // Middleware (order matters)
  bot.use(errorHandler())
  bot.use(dedupMiddleware())
  bot.use(rateLimitMiddleware())
  bot.use(authMiddleware())

  // Core commands — register with Telegraf AND populate handler map for @cmd dispatch
  const coreEntries: ReadonlyArray<[string, (ctx: BotContext) => Promise<void>]> = [
    ['start', startCommand],
    ['login', loginCommand],
    ['logout', logoutCommand],
    ['projects', projectsCommand],
    ['select', selectCommand],
    ['status', statusCommand],
    ['cancel', cancelCommand],
    ['model', modelCommand],
    ['help', helpCommand],
    ['new', newSessionCommand],
    ['fav', favCommand],
    ['todo', todoCommand],
    ['todos', todosCommand],
    ['idea', ideaCommand],
    ['ideas', ideasCommand],
    ['mkdir', mkdirCommand],
    ['cd', cdCommand],
    ['prompt', promptCommand],
    ['run', runCommand],
    ['chat', chatCommand],
    ['restart', restartCommand],
    ['newbot', newbotCommand],
    ['store', storeCommand],
    ['install', installCommand],
    ['uninstall', uninstallCommand],
    ['asr', asrCommand],
    ['context', contextCommand],
    ['reload', reloadCommand],
    ['deploy', deployCommand],
    ['sync', syncCommand],
    ['pair', pairCommand],
    ['unpair', unpairCommand],
    ['rpair', rpairCommand],
    ['grab', grabCommand],
    ['claudemd', claudemdCommand],
    ['rstatus', rstatusCommand],
    ['rlog', rlogCommand],
    ['parallel', parallelCommand],
    ['ctx', ctxCommand],
    ['deep', deepCommand],
  ]
  for (const [name, handler] of coreEntries) {
    bot.command(name, handler)
    coreHandlers.set(name, handler)
  }

  // Bookmark shortcuts /1 through /9
  for (let i = 1; i <= 9; i++) {
    bot.command(String(i), shortcutCommand)
  }

  // Load plugins and register dispatchers
  const plugins = await loadPlugins(getEnabledPlugins())

  // Collect all command names: active + discovered (for pre-registration)
  const activeCommandNames = new Set(
    plugins.flatMap((p) => p.commands.map((cmd) => cmd.name))
  )
  const discoveredNames = await discoverAllPluginCommandNames()
  const allNames = new Set([...activeCommandNames, ...discoveredNames])

  // Pre-register dispatchers for ALL discoverable plugin commands
  // Active ones dispatch to real handlers; inactive ones reply "not enabled"
  // This ensures newly enabled plugins work after /reload without restart
  for (const name of allNames) {
    bot.command(name, (ctx) => dispatchPluginCommand(name, ctx))
  }

  // Wire plugin-specific integrations (uses same module instance from loader)
  wireReminderSendFn(bot)
  wireSchedulerSendFn(bot)
  wireTaskSendFn(bot)

  // Plugin interceptor — dynamic command dispatch + message handlers
  // Catches plugin commands installed after startup (e.g., via /install)
  bot.on('text', async (ctx, next) => {
    const text = ctx.message?.text ?? ''
    if (text.startsWith('/')) {
      const cmdName = text.slice(1).split(/[@\s]/)[0]
      if (cmdName && isPluginCommand(cmdName)) {
        await dispatchPluginCommand(cmdName, ctx)
        return
      }
    }
    const handled = await dispatchPluginMessage(ctx)
    if (handled) return
    return next()
  })

  // Callback queries: restart → plugins → core handler
  bot.on('callback_query', async (ctx, next) => {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return next()
    const data = ctx.callbackQuery.data
    if (!data) return next()

    // Restart callback (before plugins)
    const restartHandled = await handleRestartCallback(ctx, data)
    if (restartHandled) return

    const pluginHandled = await dispatchPluginCallback(ctx, data)
    if (pluginHandled) return

    return callbackHandler(ctx)
  })

  // Photo, document, and voice messages → Claude
  bot.on('photo', photoHandler)
  bot.on('document', documentHandler)
  bot.on('voice', voiceHandler)

  // Text messages → Claude
  bot.on('text', messageHandler)

  // Set up the queue processor
  setupQueueProcessor(bot)

  // Store bot instance for bio updates + reload
  setBotInstance(bot)
  botInstance = bot

  // Start dashboard heartbeat writer + command reader
  startHeartbeat()
  startCommandReader()

  // Pre-spawn Sherpa ASR process (avoid cold start on first voice)
  if (isSherpaAvailable()) {
    warmupSherpa()

    // Inject project names as hotwords so ASR recognises them correctly
    const projectNames = scanProjects().map((p) => p.name)
    // Delay slightly to let Sherpa finish init before sending commands
    setTimeout(() => { addHotwords(projectNames).catch(() => {}) }, 3_000)
  }

  // Register commands with Telegram for autocomplete (core + plugins)
  const pluginCommands = plugins.flatMap((p) =>
    p.commands.map((cmd) => ({ command: cmd.name, description: cmd.description }))
  )

  // Inject all commands into system prompt so Claude knows what's available
  setAvailableCommands([...CORE_COMMANDS, ...pluginCommands])

  bot.telegram.setMyCommands([...CORE_COMMANDS, ...pluginCommands]).catch(() => {})

  // After restart, notify users who had active projects with a "Continue?" button
  scheduleRestartNotifications(bot)

  // Notify Telegram when remote pairing connects/disconnects
  onPairingConnect((session, label) => {
    bot.telegram.sendMessage(
      session.chatId,
      `🔗 *遠端已連線* — ${label}\n_可以開始操作遠端電腦了_`,
      { parse_mode: 'Markdown' },
    ).catch(() => {})
  })
  onPairingDisconnect((session) => {
    bot.telegram.sendMessage(
      session.chatId,
      '🔌 遠端已斷開連線',
    ).catch(() => {})
  })

  return bot
}
