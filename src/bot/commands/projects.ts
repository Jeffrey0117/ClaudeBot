import type { BotContext } from '../../types/context.js'
import { Markup } from 'telegraf'
import { scanProjects } from '../../config/projects.js'
import { buildProjectKeyboard } from '../../telegram/keyboard-builder.js'
import { isRemoteOnly } from '../../auth/auth-service.js'
import { getPairing } from '../../remote/pairing-store.js'
import { callAgentTool } from '../../remote/relay-server.js'
import { isVirtualChat, getVirtualChatPairingCode } from '../../remote/virtual-chat-store.js'

export async function projectsCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id

  // Remote-only users: list projects from their agent's base-dir
  if (isRemoteOnly(chatId)) {
    let code: string | null = null

    if (isVirtualChat(chatId)) {
      code = getVirtualChatPairingCode(chatId)
    } else {
      const pairing = getPairing(chatId, threadId)
      if (pairing?.connected) code = pairing.code
    }

    if (!code) {
      await ctx.reply('\u{26A0}\u{FE0F} \u{8ACB}\u{5148} /pair \u{9023}\u{7DDA}\u{4F60}\u{7684}\u{96FB}\u{8166}')
      return
    }
    try {
      const result = await callAgentTool(code, 'remote_list_projects', {})
      const names: string[] = JSON.parse(result)
      if (names.length === 0) {
        await ctx.reply('\u{1F4C1} \u{627E}\u{4E0D}\u{5230}\u{5C08}\u{6848}\u{8CC7}\u{6599}\u{593E}')
        return
      }
      const buttons = names.map((n) => Markup.button.callback(n, `rproject:${n}`))
      const rows: ReturnType<typeof Markup.button.callback>[][] = []
      for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2))
      }
      await ctx.reply(
        `\u{1F4C1} \u{9078}\u{64C7}\u{5C08}\u{6848} (\u{5171} ${names.length} \u{500B}):`,
        Markup.inlineKeyboard(rows),
      )
    } catch {
      await ctx.reply('\u{274C} \u{7121}\u{6CD5}\u{9023}\u{7DDA}\u{9060}\u{7AEF}\u{96FB}\u{8166}\u{FF0C}\u{8ACB}\u{78BA}\u{8A8D} agent \u{6B63}\u{5728}\u{904B}\u{884C}')
    }
    return
  }

  // Local users: scan local project directories
  const projects = scanProjects()

  if (projects.length === 0) {
    await ctx.reply('\u{627E}\u{4E0D}\u{5230}\u{5C08}\u{6848}\u{3002}\u{8ACB}\u{6AA2}\u{67E5} PROJECTS_BASE_DIR \u{8A2D}\u{5B9A}\u{3002}')
    return
  }

  const keyboard = buildProjectKeyboard(projects)
  await ctx.reply(`\u{1F4C1} \u{9078}\u{64C7}\u{5C08}\u{6848} (\u{5171} ${projects.length} \u{500B}):`, keyboard)
}
