/**
 * IG media handler — videos sent to the bot land in IG_VIDEOS_DIR,
 * ready for (or immediately used by) the /ig CDP posting flow.
 *
 *  - Video + caption `/ig <文案>` → save to Videos dir → post to IG now
 *  - Video without /ig caption    → save, reply with a ready-made command
 *
 * Telegram Bot API caps bot downloads at 20MB — larger files get a hint
 * instead of a cryptic failure.
 */

import { writeFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BotContext } from '../../types/context.js'
import { runIgPostScript, IG_VIDEOS_DIR } from '../commands/ig-post.js'

const TELEGRAM_BOT_FILE_LIMIT = 20 * 1024 * 1024

/** Strip path separators / traversal; keep a usable filename. */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, '_').replace(/\.\./g, '_').trim()
}

/** Pick a non-colliding filename inside IG_VIDEOS_DIR. */
async function uniqueTargetName(desired: string): Promise<string> {
  try {
    await stat(join(IG_VIDEOS_DIR, desired))
  } catch {
    return desired // doesn't exist — use as-is
  }
  const dot = desired.lastIndexOf('.')
  const base = dot > 0 ? desired.slice(0, dot) : desired
  const ext = dot > 0 ? desired.slice(dot) : ''
  return `${base}-${Date.now()}${ext}`
}

/** Extract caption text after a leading /ig (e.g. "/ig 今天的文案"). */
function parseIgCaption(caption: string): string | null {
  const m = caption.match(/^\/ig\s+([\s\S]+)$/i)
  return m ? m[1].trim() : null
}

interface IncomingMedia {
  readonly fileId: string
  readonly fileName?: string
  readonly fileSize?: number
}

/**
 * Save an incoming Telegram video into IG_VIDEOS_DIR.
 * If caption is `/ig <文案>`, immediately post it through the CDP flow.
 */
async function saveIncomingIgMedia(
  ctx: BotContext,
  media: IncomingMedia,
  caption: string,
): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  if (media.fileSize && media.fileSize > TELEGRAM_BOT_FILE_LIMIT) {
    const mb = (media.fileSize / 1024 / 1024).toFixed(1)
    await ctx.reply(
      `❌ 檔案 ${mb}MB 超過 Telegram Bot 下載上限 (20MB)\n` +
      `壓縮後再傳，或直接放到 ${IG_VIDEOS_DIR} 再用 /ig post`,
    )
    return
  }

  const igCaption = parseIgCaption(caption)
  const desired = sanitizeFilename(media.fileName ?? '') || `tg-${Date.now()}.mp4`

  let savedName: string
  try {
    const fileLink = await ctx.telegram.getFileLink(media.fileId)
    const res = await fetch(fileLink.href)
    if (!res.ok) throw new Error(`Telegram download failed: ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())

    await mkdir(IG_VIDEOS_DIR, { recursive: true })
    savedName = await uniqueTargetName(desired)
    await writeFile(join(IG_VIDEOS_DIR, savedName), buffer)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`❌ 影片下載/儲存失敗: ${msg}`)
    return
  }

  // No /ig caption → just saved; hand the user a ready-made command
  if (!igCaption) {
    await ctx.reply(
      `✅ 已存到 Videos: \`${savedName}\`\n\n` +
      `發文: \`/ig post ${savedName} <文案>\`\n` +
      `排程: \`/ig add 2026-06-07T14:00 ${savedName} <文案>\``,
      { parse_mode: 'Markdown' },
    )
    return
  }

  // /ig caption → post right now through the CDP engine
  const statusMsg = await ctx.reply(
    `📸 IG 發文中...\n📁 ${savedName}\n✏️ ${igCaption.slice(0, 60)}${igCaption.length > 60 ? '...' : ''}`,
  )
  try {
    const result = await runIgPostScript(savedName, igCaption, chatId)
    const statusText = result.success
      ? `✅ IG 發文成功！\n📁 ${savedName}\n⏱ ${result.duration_s.toFixed(1)}s`
      : `❌ IG 發文失敗\n📁 ${savedName}\n💥 ${result.error ?? 'Unknown error'}${result.step ? `\n📍 步驟: ${result.step}` : ''}`
    await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, statusText)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `❌ IG 發文異常: ${msg}`,
    )
  }
}

/** bot.on('video') — Telegram video messages (sent as video, not file). */
export async function videoHandler(ctx: BotContext): Promise<void> {
  const message = ctx.message
  if (!message || !('video' in message) || !message.video) return

  const caption = ('caption' in message ? message.caption : '') ?? ''
  await saveIncomingIgMedia(ctx, {
    fileId: message.video.file_id,
    fileName: message.video.file_name,
    fileSize: message.video.file_size,
  }, caption)
}

/**
 * Video sent as a *file* (document with video/* mime). Called from
 * documentHandler. Returns true if handled (so the remote-push branch
 * is skipped), false to let the original flow continue.
 */
export async function tryHandleVideoDocument(ctx: BotContext): Promise<boolean> {
  const message = ctx.message
  if (!message || !('document' in message) || !message.document) return false

  const { mime_type: mimeType, file_id: fileId, file_name: fileName, file_size: fileSize } = message.document
  if (!mimeType?.startsWith('video/')) return false

  const caption = ('caption' in message ? message.caption : '') ?? ''
  await saveIncomingIgMedia(ctx, { fileId, fileName, fileSize }, caption)
  return true
}
