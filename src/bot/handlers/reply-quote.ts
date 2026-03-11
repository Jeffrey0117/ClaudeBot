/**
 * Extract reply/quote content from a Telegram message.
 * Supports text, captions, and voice message transcription.
 */

import type { BotContext } from '../../types/context.js'
import { transcribeVoiceFile } from './voice-handler.js'

export async function extractReplyQuote(ctx: BotContext): Promise<string> {
  const reply = ctx.message && 'reply_to_message' in ctx.message
    ? ctx.message.reply_to_message
    : undefined
  if (!reply) return ''

  // Text or caption
  const replyText = reply && 'text' in reply ? reply.text : ''
  const caption = reply && 'caption' in reply ? reply.caption : ''
  const textContent = replyText || caption || ''

  if (textContent) {
    return `> [引用訊息]\n> ${textContent.split('\n').join('\n> ')}\n\n`
  }

  // Voice message — transcribe it
  if ('voice' in reply && reply.voice) {
    const voiceResult = await transcribeVoiceFile(reply.voice.file_id, ctx.telegram)
    if (voiceResult.text) {
      return `> [引用語音]\n> ${voiceResult.text.split('\n').join('\n> ')}\n\n`
    }
  }

  return ''
}
