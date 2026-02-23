import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'
import type { ProjectInfo } from '../types/index.js'

let botInstance: Telegraf<BotContext> | null = null
const pinnedMessages = new Map<number, number>() // chatId → message_id

export function setBotInstance(bot: Telegraf<BotContext>): void {
  botInstance = bot
}

export async function updateBotBio(project: ProjectInfo | null): Promise<void> {
  if (!botInstance) return

  const description = project
    ? `Claude Code \u{9059}\u{7AEF}\u{64CD}\u{63A7} | \u{1F4C2} ${project.name}`
    : 'Claude Code \u{9059}\u{7AEF}\u{64CD}\u{63A7} | \u{672A}\u{9078}\u{64C7}\u{5C08}\u{6848}'

  const shortDescription = project
    ? `\u{1F4C2} ${project.name}`
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
    // Unpin and delete previous pin message
    const prevMsgId = pinnedMessages.get(chatId)
    if (prevMsgId) {
      await botInstance.telegram.unpinChatMessage(chatId, prevMsgId).catch(() => {})
      await botInstance.telegram.deleteMessage(chatId, prevMsgId).catch(() => {})
    }

    const msg = await botInstance.telegram.sendMessage(
      chatId,
      `\u{1F4CC} *[${project.name}]* | \u{1F916} ${model}`,
      { parse_mode: 'Markdown' }
    )

    pinnedMessages.set(chatId, msg.message_id)

    await botInstance.telegram.pinChatMessage(chatId, msg.message_id, {
      disable_notification: true,
    }).catch(() => {
      // Pin might fail in private chats or without permissions
    })
  } catch (error) {
    console.error('[bio-updater] Failed to pin status:', error)
  }
}
