import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import type { ProjectInfo } from '../types/index.js'

let botInstance: Telegraf<BotContext> | null = null

export function setBotInstance(bot: Telegraf<BotContext>): void {
  botInstance = bot
}

export async function updateBotBio(project: ProjectInfo | null): Promise<void> {
  if (!botInstance) return

  const description = project
    ? `Claude Code 遠端操控 | 📂 ${project.name}`
    : 'Claude Code 遠端操控 | 未選擇專案'

  const shortDescription = project
    ? `📂 ${project.name}`
    : 'Claude Code Bot'

  try {
    await botInstance.telegram.setMyDescription(description)
    await botInstance.telegram.setMyShortDescription(shortDescription)
  } catch (error) {
    console.error('[bio-updater] Failed to update bio:', error)
  }
}

export async function pinProjectStatus(
  chatId: number,
  project: ProjectInfo,
  model: string,
): Promise<void> {
  if (!botInstance) return

  try {
    const msg = await botInstance.telegram.sendMessage(
      chatId,
      `📌 *${project.name}*\n📂 \`${project.path}\`\n🤖 ${model}`,
      { parse_mode: 'Markdown' }
    )
    await botInstance.telegram.pinChatMessage(chatId, msg.message_id, {
      disable_notification: true,
    }).catch(() => {
      // Pin might fail in private chats or without permissions
    })
  } catch (error) {
    console.error('[bio-updater] Failed to pin status:', error)
  }
}
