import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { resolveBackend } from '../../ai/types.js'
import { getAISessionId } from '../../ai/session-store.js'
import { enqueue } from '../../claude/queue.js'
import { downloadImage } from '../../utils/image-downloader.js'
import { getPairing } from '../../remote/pairing-store.js'
import { remoteToolCall } from '../../remote/relay-client.js'

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
    await ctx.reply('\u{7528} /projects \u{9078}\u{64C7}\u{5C08}\u{6848}\u{FF0C}\u{6216} /chat \u{9032}\u{5165}\u{901A}\u{7528}\u{5C0D}\u{8A71}\u{6A21}\u{5F0F}\u{3002}')
    return
  }

  const project = state.selectedProject

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
  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)

  try {
    const fileLink = await ctx.telegram.getFileLink(fileId)
    const extension = getExtension(fileLink.href)
    const imagePath = await downloadImage(fileLink.href, extension)

    enqueue({
      chatId,
      prompt,
      project,
      ai: state.ai,
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

  const { mime_type: mimeType, file_id: fileId, file_name: fileName } = message.document
  const isImage = mimeType != null && IMAGE_MIME_TYPES.has(mimeType)
  const threadId = message.message_thread_id
  const caption = ('caption' in message ? message.caption : '') || ''

  // Non-image file + active pairing → push to remote
  if (!isImage) {
    const pairing = getPairing(chatId, threadId)
    if (pairing?.connected) {
      await pushToRemote(ctx, pairing.code, fileId, fileName ?? 'file', caption)
      return
    }
    // No pairing — silently ignore non-image docs (original behaviour)
    return
  }

  // Image document → send to AI (original flow)
  const state = getUserState(chatId)
  if (!state.selectedProject) {
    await ctx.reply('\u{7528} /projects \u{9078}\u{64C7}\u{5C08}\u{6848}\u{FF0C}\u{6216} /chat \u{9032}\u{5165}\u{901A}\u{7528}\u{5C0D}\u{8A71}\u{6A21}\u{5F0F}\u{3002}')
    return
  }

  const project = state.selectedProject
  const prompt = caption || DEFAULT_PROMPT
  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)

  try {
    const fileLink = await ctx.telegram.getFileLink(fileId)
    const extension = getExtensionFromMime(mimeType!)
    const imagePath = await downloadImage(fileLink.href, extension)

    enqueue({
      chatId,
      prompt,
      project,
      ai: state.ai,
      sessionId,
      imagePaths: [imagePath],
    })

    await ctx.reply('⏳ Image queued...')
  } catch (error) {
    console.error('[photo-handler] Failed to download document image:', error)
    await ctx.reply('Failed to download image. Please try again.')
  }
}

async function pushToRemote(
  ctx: BotContext,
  code: string,
  fileId: string,
  fileName: string,
  caption: string,
): Promise<void> {
  const remotePath = caption.trim() || `~/Downloads/${fileName}`

  try {
    const fileLink = await ctx.telegram.getFileLink(fileId)
    const res = await fetch(fileLink.href)
    if (!res.ok) throw new Error(`Telegram download failed: ${res.status}`)
    const arrayBuf = await res.arrayBuffer()
    const base64 = Buffer.from(arrayBuf).toString('base64')

    await remoteToolCall(code, 'remote_push_file', { path: remotePath, base64 })
    await ctx.reply(`✅ 已傳到遠端 \`${remotePath}\``, { parse_mode: 'Markdown' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`❌ 上傳失敗: ${msg}`)
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
