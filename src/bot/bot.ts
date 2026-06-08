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
import { detectDeployIntent, runDeployFromIntent } from './deploy-intent.js'
import { detectOpsIntent, runOpsIntent } from './ops-intent.js'
import { handleOpsCallback } from './ops-callbacks.js'
import { syncCommand } from './commands/sync.js'
import { landCommand } from './commands/land.js'
import { fabricCommand } from './commands/fabric.js'
import { bootstrapCommand } from './commands/bootstrap.js'
import {
  ronCommand, rxCommand, rstatCommand, ropenCommand,
  rkillCommand, rpowerCommand, rpullCommand, rclipCommand,
  rnotifyCommand, rlsCommand, rshotCommand, jsCommand, selfupdateCommand,
} from './commands/remote-ops.js'
import { pairCommand, unpairCommand } from './commands/pair.js'
import { machinesCommand } from './commands/machines.js'
import { rpairCommand } from './commands/rpair.js'
import { grabCommand } from './commands/grab.js'
import { claudemdCommand } from './commands/claudemd.js'
import { rstatusCommand } from './commands/rstatus.js'
import { rlogCommand } from './commands/rlog.js'
import { parallelCommand } from './commands/parallel.js'
import { ctxCommand } from './commands/ctx.js'
import { deepCommand } from './commands/deep.js'
import { browseVisionCommand } from './commands/browse-vision.js'
import { igCommand } from './commands/ig-post.js'
import { setIgSchedulerSendFn, startIgScheduler } from './commands/ig-scheduler.js'
import { lastCommand } from './commands/last.js'
import { licenseCommand } from './commands/license.js'
import { channelCommand } from './commands/channel.js'
import { sniffCommand } from './commands/sniff.js'
import { usCommand } from './commands/us.js'
import { igdlCommand } from './commands/igdl.js'
import { messageHandler } from './handlers/message-handler.js'
import { callbackHandler } from './handlers/callback-handler.js'
import { photoHandler, documentHandler } from './handlers/photo-handler.js'
import { videoHandler } from './handlers/ig-media-handler.js'
import { voiceHandler } from './handlers/voice-handler.js'
import { setAllotRejectNotify } from './ordered-message-buffer.js'
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
import { onPairingConnect, onPairingDisconnect, getPairings, remoteProjectPath } from '../remote/pairing-store.js'
import { remoteToolCall } from '../remote/relay-client.js'
import { setUserProject, getActiveMachine, setActiveMachine } from './state.js'
import { createTelegramProxy } from '../remote/telegram-proxy.js'

/** Remote pairing codes we've already auto-provisioned agent-browser on
 *  (per bot process) — so we install at most once per connection. */
const provisionedBrowser = new Set<string>()

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
  { command: 'land', description: '把 bot 改動併回 master' },
  { command: 'fabric', description: '打包專案投遞到遠端機器跑' },
  { command: 'bootstrap', description: '在遠端機器裝設定環境 (clone 設定repo + install)' },
  { command: 'ron', description: '在遠端機器開 app/GUI (秒開可見)' },
  { command: 'rx', description: '在遠端機器跑指令拿輸出' },
  { command: 'rstat', description: '看遠端機器系統狀態' },
  { command: 'ropen', description: '在遠端機器開網址' },
  { command: 'rkill', description: '殺遠端機器的程式 (名稱或PID)' },
  { command: 'rpower', description: '遠端電源: lock/sleep/reboot/shutdown/cancel' },
  { command: 'rpull', description: '在遠端機器 git pull 某專案目錄' },
  { command: 'rclip', description: '讀/寫遠端機器剪貼簿' },
  { command: 'rnotify', description: '在遠端機器跳桌面通知' },
  { command: 'rls', description: '列遠端機器某目錄' },
  { command: 'rshot', description: '遠端機器螢幕截圖傳回來' },
  { command: 'js', description: '在瀏覽器執行 JS (CDP)' },
  { command: 'selfupdate', description: '遠端機器自己信任憑證+下載安裝最新版' },
  { command: 'pair', description: '配對遠端電腦 (code@ip:port)' },
  { command: 'unpair', description: '斷開遠端配對' },
  { command: 'machines', description: '已配對機器列表/切換' },
  { command: 'rpair', description: '重啟遠端 agent' },
  { command: 'grab', description: '從遠端下載檔案' },
  { command: 'claudemd', description: '自動生成/更新 CLAUDE.md' },
  { command: 'rstatus', description: '查看遠端系統狀態' },
  { command: 'rlog', description: '查看遠端 log' },
  { command: 'parallel', description: '平行執行多個任務' },
  { command: 'ctx', description: '查看/管理上下文摘要' },
  { command: 'deep', description: '深度分析 (opus + subagent)' },
  { command: 'bv', description: '網頁視覺分析 (Gemini)' },
  { command: 'last', description: '重送最近的訊息 (/last2=上上條)' },
  { command: 'help', description: '顯示說明' },
  { command: 'channel', description: '切換 channel session 模式 (on/off/status)' },
  { command: 'sniff', description: '抓網頁背後的 JSON API' },
  { command: 'us', description: '跑油猴腳本（注入+下載）' },
  { command: 'igdl', description: '下載 IG 貼文/Reel（貼連結即可）' },
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

  // Wrap telegram API to intercept virtual chatId calls (Electron chat users)
  bot.telegram = createTelegramProxy(bot.telegram)

  // Middleware (order matters)
  bot.use(errorHandler())
  bot.use(dedupMiddleware())
  bot.use(rateLimitMiddleware())
  bot.use(authMiddleware())

  // Fix: Telegram clients sometimes send registered commands as text_link
  // with tg://bot_command URLs instead of bot_command entities.
  // Telegraf only matches bot_command, so we normalize here.
  bot.use((ctx, next) => {
    const msg = ctx.message
    if (msg && 'entities' in msg && msg.entities) {
      for (const entity of msg.entities) {
        if (entity.type === 'text_link' && (entity as { url?: string }).url?.startsWith('tg://bot_command')) {
          Object.assign(entity, { type: 'bot_command', url: undefined })
        }
      }
    }
    return next()
  })

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
    ['land', landCommand],
    ['fabric', fabricCommand],
    ['bootstrap', bootstrapCommand],
    ['ron', ronCommand],
    ['rx', rxCommand],
    ['rstat', rstatCommand],
    ['ropen', ropenCommand],
    ['rkill', rkillCommand],
    ['rpower', rpowerCommand],
    ['rpull', rpullCommand],
    ['rclip', rclipCommand],
    ['rnotify', rnotifyCommand],
    ['rls', rlsCommand],
    ['rshot', rshotCommand],
    ['js', jsCommand],
    ['selfupdate', selfupdateCommand],
    ['pair', pairCommand],
    ['unpair', unpairCommand],
    ['machines', machinesCommand],
    ['rpair', rpairCommand],
    ['grab', grabCommand],
    ['claudemd', claudemdCommand],
    ['rstatus', rstatusCommand],
    ['rlog', rlogCommand],
    ['parallel', parallelCommand],
    ['ctx', ctxCommand],
    ['deep', deepCommand],
    ['bv', browseVisionCommand],
    ['ig', igCommand],
    ['last', lastCommand],
    ['last1', lastCommand],
    ['last2', lastCommand],
    ['last3', lastCommand],
    ['last4', lastCommand],
    ['last5', lastCommand],
    ['license', licenseCommand],
    ['channel', channelCommand],
    ['sniff', sniffCommand],
    ['us', usCommand],
    ['igdl', igdlCommand],
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

  // Wire IG scheduler
  setIgSchedulerSendFn(async (chatId, text) => {
    await bot.telegram.sendMessage(chatId, text)
  })
  startIgScheduler()

  // Wire allot reject notification (ordered-message-buffer → Telegram)
  setAllotRejectNotify((chatId, text) => {
    bot.telegram.sendMessage(chatId, text).catch(() => {})
  })

  // Plugin interceptor — dynamic command dispatch + message handlers
  // Catches plugin commands installed after startup (e.g., via /install)
  // Also normalizes pasted text with invisible Unicode chars (zero-width, fullwidth slash)
  bot.on('text', async (ctx, next) => {
    const raw = ctx.message?.text ?? ''
    const text = raw
      .replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/^\uFF0F/, '/')
      .trim()
    if (text.startsWith('/')) {
      const cmdName = text.slice(1).split(/[@\s]/)[0]
      if (cmdName && isPluginCommand(cmdName)) {
        await dispatchPluginCommand(cmdName, ctx)
        return
      }
      // If text was normalized, try core handler dispatch
      if (text !== raw) {
        const handler = getCoreCommandHandler(cmdName)
        if (handler) {
          await handler(ctx)
          return
        }
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

    // CloudPipe ops callbacks (cp_restart / cp_rollback / cp_fix / cp_cancel)
    const opsHandled = await handleOpsCallback(ctx, data)
    if (opsHandled) return

    const pluginHandled = await dispatchPluginCallback(ctx, data)
    if (pluginHandled) return

    return callbackHandler(ctx)
  })

  // Photo, document, and voice messages → Claude
  bot.on('photo', photoHandler)
  bot.on('document', documentHandler)
  // Videos → IG media flow (save to Videos dir; `/ig 文案` caption posts now)
  bot.on('video', videoHandler)
  bot.on('voice', voiceHandler)

  // Deploy-intent shortcut — runs `/deploy` directly for terse "部署 …" / "deploy …"
  // commands, bypassing Claude to save quota and dodge the Anthropic rate-limit
  // cooldown. Conservative matcher; anything else falls through to Claude.
  bot.on('text', async (ctx, next) => {
    const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
    const intent = detectDeployIntent(text)
    if (!intent) return next()
    try {
      const handled = await runDeployFromIntent(ctx, intent)
      if (handled) return
    } catch (error) {
      console.error('Deploy-intent router failed:', error)
    }
    return next()
  })

  // Ops-intent shortcut — status / logs / restart / rollback answered directly
  // from CloudPipe, bypassing Claude. Only fires when a token resolves to a real
  // project (or an explicit "all" dashboard); everything else falls through.
  bot.on('text', async (ctx, next) => {
    const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
    const intent = detectOpsIntent(text)
    if (!intent) return next()
    try {
      const handled = await runOpsIntent(ctx, intent)
      if (handled) return
    } catch (error) {
      console.error('Ops-intent router failed:', error)
    }
    return next()
  })

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

  // Auto-switch to remote project when pairing connects.
  // Notification is now sent directly in pairing-store.ts using the stored botToken.
  onPairingConnect((session, label) => {
    setUserProject(session.chatId, { name: 'remote', path: remoteProjectPath(label) }, session.threadId)
    // Auto-set as active machine if it's the first connected machine
    const currentActive = getActiveMachine(session.chatId, session.threadId)
    if (!currentActive) {
      setActiveMachine(session.chatId, label, session.threadId)
    }

    // Auto-provision browser capability on the remote (once per code) so the
    // user never has to run the setup script by hand. Best-effort, background.
    if (env.MCP_AGENT_BROWSER && !provisionedBrowser.has(session.code)) {
      provisionedBrowser.add(session.code)
      void (async () => {
        try {
          const ver = await remoteToolCall(
            session.code, 'remote_execute_command', { command: 'agent-browser --version' }, 10_000,
          ).catch(() => '')
          if (/\d/.test(String(ver))) return // already installed
          await remoteToolCall(
            session.code, 'remote_execute_command', { command: 'npm i -g agent-browser' }, 180_000,
          )
          bot.telegram.sendMessage(session.chatId, `🧩 已自動為 ${label} 裝好瀏覽器能力 (agent-browser)`).catch(() => {})
        } catch {
          provisionedBrowser.delete(session.code) // allow retry on next connect
          bot.telegram.sendMessage(
            session.chatId,
            `⚠️ ${label} 自動安裝瀏覽器能力失敗（那台可能沒有 Node.js）。需要的話在那台跑一次 scripts\\setup-remote.ps1`,
          ).catch(() => {})
        }
      })()
    }
  })

  // When active machine disconnects, auto-switch to next connected machine
  onPairingDisconnect((session, label) => {
    const currentActive = getActiveMachine(session.chatId, session.threadId)
    if (currentActive === label) {
      const remaining = getPairings(session.chatId, session.threadId).filter((s) => s.connected)
      setActiveMachine(session.chatId, remaining[0]?.label, session.threadId)
    }
  })

  return bot
}
