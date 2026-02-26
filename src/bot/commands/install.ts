import type { BotContext } from '../../types/context.js'
import {
  fetchRegistry,
  isInstalled,
  downloadPlugin,
  enablePlugin,
  getEnabledPlugins,
} from '../../plugins/plugin-manager.js'
import { reloadPlugins } from '../../plugins/loader.js'
import { getBotInstance, CORE_COMMANDS, wireReminderSendFn, wireSchedulerSendFn, wireTaskSendFn } from '../bot.js'
import { setAvailableCommands } from '../../utils/system-prompt.js'

export async function installCommand(ctx: BotContext): Promise<void> {
  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const name = raw.replace(/^\/install(@\S+)?\s*/, '').trim()

  if (!name) {
    await ctx.reply('用法: `/install <plugin名稱>`\n瀏覽可用插件: /store', { parse_mode: 'Markdown' })
    return
  }

  try {
    // Verify plugin exists in registry
    const registry = await fetchRegistry()
    const entry = registry.find((e) => e.name === name)
    if (!entry) {
      await ctx.reply(`❌ 找不到插件 \`${name}\`\n瀏覽可用插件: /store`, { parse_mode: 'Markdown' })
      return
    }

    if (isInstalled(name)) {
      // Already installed — just enable if not enabled
      const enabled = getEnabledPlugins()
      if (enabled.includes(name)) {
        await ctx.reply(`✅ \`${name}\` 已經安裝並啟用`, { parse_mode: 'Markdown' })
        return
      }
      enablePlugin(name)
      await reloadAndNotify(ctx, name, '啟用')
      return
    }

    // Download + enable + reload
    const statusMsg = await ctx.reply(`⏳ 正在下載 \`${name}\`...`, { parse_mode: 'Markdown' })
    await downloadPlugin(name)
    enablePlugin(name)
    await reloadAndNotify(ctx, name, '安裝')

    // Delete the "downloading" message
    await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {})
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.reply(`❌ 安裝失敗: ${msg}`)
  }
}

async function reloadAndNotify(ctx: BotContext, name: string, action: string): Promise<void> {
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

  const loaded = plugins.find((p) => p.name === name)
  const cmdList = loaded
    ? loaded.commands.map((c) => `  /${c.name} — ${c.description}`).join('\n')
    : ''

  await ctx.reply(
    `✅ *${name}* ${action}成功\n\n${cmdList ? `*可用指令:*\n${cmdList}` : ''}`,
    { parse_mode: 'Markdown' },
  )
}
