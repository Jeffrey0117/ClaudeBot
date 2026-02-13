import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { getSessionId } from '../../claude/session-store.js'
import { enqueue } from '../../claude/queue.js'
import { downloadImage } from '../../utils/image-downloader.js'

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
])

const DEFAULT_PROMPT = '請分析這張圖片'

export async function photoHandler(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const state = getUserState(chatId)
  if (!state.selectedProject) {
    await ctx.reply('No project selected. Use /projects to pick one first.')
    return
  }

  const message = ctx.message
  if (!message || !('photo' in message) || !message.photo) return

  // Telegram sends multiple sizes, pick the largest (last one)
  const fileId = message.photo[message.photo.length - 1]?.file_id
  if (!fileId) {
    await ctx.reply('Unable to process this image.')
    return
  }

  const caption = message.caption || ''
  const prompt = caption || DEFAULT_PROMPT

  const project = state.selectedProject
  const sessionId = getSessionId(project.path)

  try {
    const fileLink = await ctx.telegram.getFileLink(fileId)
    const extension = getExtension(fileLink.href)
    const imagePath = await downloadImage(fileLink.href, extension)

    enqueue({
      chatId,
      prompt,
      project,
      model: state.model,
      sessionId,
      imagePaths: [imagePath],
    })

    await ctx.reply('⏳ Image queued...')
  } catch (error) {
    console.error('[photo-handler] Failed to download image:', error)
    await ctx.reply('Failed to download image. Please try again.')
  }
}

export async function documentHandler(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const message = ctx.message
  if (!message || !('document' in message) || !message.document) return

  const { mime_type: mimeType, file_id: fileId } = message.document
  if (!mimeType || !IMAGE_MIME_TYPES.has(mimeType)) {
    return // Not an image document, ignore silently
  }

  const state = getUserState(chatId)
  if (!state.selectedProject) {
    await ctx.reply('No project selected. Use /projects to pick one first.')
    return
  }

  const caption = ('caption' in message ? message.caption : '') || ''
  const prompt = caption || DEFAULT_PROMPT

  const project = state.selectedProject
  const sessionId = getSessionId(project.path)

  try {
    const fileLink = await ctx.telegram.getFileLink(fileId)
    const extension = getExtensionFromMime(mimeType)
    const imagePath = await downloadImage(fileLink.href, extension)

    enqueue({
      chatId,
      prompt,
      project,
      model: state.model,
      sessionId,
      imagePaths: [imagePath],
    })

    await ctx.reply('⏳ Image queued...')
  } catch (error) {
    console.error('[photo-handler] Failed to download document image:', error)
    await ctx.reply('Failed to download image. Please try again.')
  }
}

function getExtension(url: string): string {
  const pathname = new URL(url).pathname
  const ext = pathname.split('.').pop()?.toLowerCase()
  if (ext && ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) {
    return ext
  }
  return 'jpg'
}

function getExtensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
  }
  return map[mimeType] ?? 'jpg'
}
