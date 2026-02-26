import type { BotContext } from '../../types/context.js'
import {
  isInstalled,
  removePlugin,
  disablePlugin,
  getEnabledPlugins,
} from '../../plugins/plugin-manager.js'
import { reloadPlugins } from '../../plugins/loader.js'
import { getBotInstance, CORE_COMMANDS, wireReminderSendFn, wireSchedulerSendFn, wireTaskSendFn } from '../bot.js'
import { setAvailableCommands } from '../../utils/system-prompt.js'

export async function uninstallCommand(ctx: BotContext): Promise<void> {
  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const name = raw.replace(/^\/uninstall(@\S+)?\s*/, '').trim()

  if (!name) {
    await ctx.reply('用法: `/uninstall <plugin名稱>`', { parse_mode: 'Markdown' })
    return
  }

  if (!isInstalled(name)) {
    await ctx.reply(`❌ 插件 \`${name}\` 尚未安裝`, { parse_mode: 'Markdown' })
    return
  }

  try {
    // Remove files + disable + reload
    removePlugin(name)
    disablePlugin(name)

    const plugins = await reloadPlugins(getEnabledPlugins())

    const bot = getBotInstance()
    if (bot) {
      wireReminderSendFn(bot)
      wireSchedulerSendFn(bot)
      wireTaskSendFn(bot)

      const pluginCommands = plugins.flatMap((p) =>
        p.commands.map((cmd) => ({ command: cmd.name, description: cmd.description }))
      )
      setAvailableCommands([...CORE_COMMANDS, ...pluginCommands])
      await bot.telegram.setMyCommands([...CORE_COMMANDS, ...pluginCommands]).catch(() => {})
    }

    await ctx.reply(`🗑️ *${name}* 已卸載`, { parse_mode: 'Markdown' })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.reply(`❌ 卸載失敗: ${msg}`)
  }
}
