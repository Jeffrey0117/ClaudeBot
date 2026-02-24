/**
 * Voice message handler.
 * Downloads OGG → ffmpeg converts to 16 kHz WAV → Sherpa ASR → enqueue as prompt.
 */

import { execFile } from 'node:child_process'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { BotContext } from '../../types/context.js'
import type { AIBackend } from '../../types/index.js'
import { getUserState } from '../state.js'
import { getAISessionId } from '../../ai/session-store.js'
import { enqueue } from '../../claude/queue.js'
import { transcribeAudio } from '../../asr/sherpa-client.js'
import { env } from '../../config/env.js'

const execFileAsync = promisify(execFile)
const TEMP_DIR = join(tmpdir(), 'claudebot-voice')

async function ensureTempDir(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true })
}

function resolveBackend(backend: AIBackend): AIBackend {
  return backend === 'auto' ? 'claude' : backend
}

async function cleanupFiles(...paths: string[]): Promise<void> {
  for (const p of paths) {
    try { await unlink(p) } catch { /* ignore */ }
  }
}

export async function voiceHandler(ctx: BotContext): Promise<void> {
  if (!env.SHERPA_SERVER_PATH) return

  const chatId = ctx.chat?.id
  if (!chatId) return

  const message = ctx.message
  if (!message || !('voice' in message) || !message.voice) return

  const threadId = message.message_thread_id
  const state = getUserState(chatId, threadId)

  if (!state.selectedProject) {
    await ctx.reply('\u7528 /projects \u9078\u64C7\u5C08\u6848\uFF0C\u6216 /chat \u9032\u5165\u901A\u7528\u5C0D\u8A71\u6A21\u5F0F\u3002')
    return
  }

  const project = state.selectedProject
  const fileId = message.voice.file_id

  const id = randomUUID()
  const oggPath = join(TEMP_DIR, `${id}.ogg`)
  const wavPath = join(TEMP_DIR, `${id}.wav`)

  try {
    // 1. Download OGG + ensure temp dir in parallel
    const [fileLink] = await Promise.all([
      ctx.telegram.getFileLink(fileId),
      ensureTempDir(),
    ])
    const response = await fetch(fileLink.href)
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    await writeFile(oggPath, buffer)

    // 2. Convert to 16 kHz mono WAV
    await execFileAsync('ffmpeg', [
      '-i', oggPath,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-y', wavPath,
    ])

    // 3. Transcribe via Sherpa
    const result = await transcribeAudio(wavPath)
    if (!result.success || !result.text) {
      await ctx.reply('\u274C \u8A9E\u97F3\u8FA8\u8B58\u5931\u6557\uFF0C\u8ACB\u91CD\u8A66\u3002')
      return
    }

    const text = result.text.trim()

    // 4. Enqueue immediately so Claude starts processing
    const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)
    enqueue({
      chatId,
      prompt: text,
      project,
      ai: state.ai,
      sessionId,
      imagePaths: [],
    })

    // 5. Show transcription to user (non-blocking)
    ctx.reply(`\uD83D\uDCAC ${text}`).catch(() => {})
  } catch (error) {
    console.error('[voice-handler] Failed:', error)
    await ctx.reply('\u274C \u8A9E\u97F3\u8655\u7406\u5931\u6557\uFF0C\u8ACB\u91CD\u8A66\u3002')
  } finally {
    await cleanupFiles(oggPath, wavPath)
  }
}
