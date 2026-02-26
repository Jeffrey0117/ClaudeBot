import type { BotContext } from '../../types/context.js'
import { reloadPlugins, getLoadedPlugins } from '../../plugins/loader.js'
import { getEnabledPlugins } from '../../plugins/plugin-manager.js'
import { getBotInstance, CORE_COMMANDS, wireReminderSendFn, wireSchedulerSendFn, wireTaskSendFn } from '../bot.js'
import { setAvailableCommands } from '../../utils/system-prompt.js'

export async function reloadCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  try {
    const before = getLoadedPlugins().length
    const plugins = await reloadPlugins(getEnabledPlugins())

    // Re-wire plugin integrations using the same module instance from loader
    const bot = getBotInstance()
    if (bot) {
      wireReminderSendFn(bot)
      wireSchedulerSendFn(bot)
      wireTaskSendFn(bot)

      // Update Telegram command list + system prompt
      const pluginCommands = plugins.flatMap((p) =>
        p.commands.map((cmd) => ({ command: cmd.name, description: cmd.description }))
      )
      setAvailableCommands([...CORE_COMMANDS, ...pluginCommands])
      await bot.telegram.setMyCommands([...CORE_COMMANDS, ...pluginCommands]).catch(() => {})
    }

    const names = plugins.map((p) => p.name).join(', ')
    const cmdCount = plugins.reduce((sum, p) => sum + p.commands.length, 0)

    await ctx.reply(
      `*Plugin 熱重載完成*\n`
      + `載入前: ${before} 個插件\n`
      + `載入後: ${plugins.length} 個插件, ${cmdCount} 個指令\n`
      + (names ? `插件: ${names}` : '（無啟用插件）'),
      { parse_mode: 'Markdown' }
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.reply(`重載失敗: ${msg}`)
  }
}
