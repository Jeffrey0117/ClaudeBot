/**
 * Voice message handler.
 * Downloads OGG → ffmpeg converts to 16 kHz WAV → Sherpa ASR →
 * LLM refinement (fix typos/grammar) → enqueue as prompt.
 */

import { execFile } from 'node:child_process'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { resolveBackend } from '../../ai/types.js'
import { getAISessionId } from '../../ai/session-store.js'
import { enqueue } from '../../claude/queue.js'
import { transcribeAudio } from '../../asr/sherpa-client.js'
import { recordActivity } from '../../plugins/stats/activity-logger.js'
import { env } from '../../config/env.js'
import { getAsrMode, consumeAsrMode } from '../asr-store.js'

const execFileAsync = promisify(execFile)

const REFINE_PROMPT = [
  '你是語音辨識後處理器。以下是 ASR 辨識的原始文字，可能有錯字、漏字、中英混雜錯誤。',
  '請修正成通順的繁體中文（保留英文專有名詞），並加上適當的標點符號（逗號、句號、問號等）。',
  '規則：只輸出修正後的文字，不要解釋、不要加引號、不要改變語意。',
  '如果原文已經正確，只需加上標點即可。',
].join('')

/**
 * Use Gemini CLI (flash-lite, fastest & free) to refine ASR output.
 * Returns corrected text, or null on failure (caller falls back to raw).
 */
async function refineWithLLM(rawText: string): Promise<string | null> {
  try {
    const prompt = `${REFINE_PROMPT}\n\n原始文字：${rawText}`
    const { stdout } = await execFileAsync('gemini', [
      '-m', 'gemini-2.5-flash-lite-preview-06-17',
      '-p', prompt,
    ], { encoding: 'utf-8', timeout: 8_000, windowsHide: true })
    const refined = stdout.trim()
    // Sanity check: don't accept empty or absurdly different-length results
    if (!refined || refined.length > rawText.length * 3) return null
    return refined
  } catch {
    return null
  }
}
const TEMP_DIR = join(tmpdir(), 'claudebot-voice')

async function ensureTempDir(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true })
}

async function cleanupFiles(...paths: string[]): Promise<void> {
  for (const p of paths) {
    try { await unlink(p) } catch { /* ignore */ }
  }
}

/**
 * Download a Telegram voice/audio file and transcribe it via Sherpa ASR + LLM refinement.
 * Returns the transcribed text, or null on failure.
 * Reusable by both voiceHandler and reply-quote extraction.
 */
export async function transcribeVoiceFile(
  fileId: string,
  telegram: BotContext['telegram'],
): Promise<string | null> {
  if (!env.SHERPA_SERVER_PATH) return null

  const id = randomUUID()
  const oggPath = join(TEMP_DIR, `${id}.ogg`)
  const wavPath = join(TEMP_DIR, `${id}.wav`)

  try {
    const [fileLink] = await Promise.all([
      telegram.getFileLink(fileId),
      ensureTempDir(),
    ])
    const response = await fetch(fileLink.href)
    if (!response.ok) return null

    const buffer = Buffer.from(await response.arrayBuffer())
    await writeFile(oggPath, buffer)

    await execFileAsync('ffmpeg', [
      '-i', oggPath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath,
    ])

    const result = await transcribeAudio(wavPath)
    if (!result.success || !result.text) return null

    const rawText = result.text.trim()
    const refined = await refineWithLLM(rawText)
    return refined ?? rawText
  } catch {
    return null
  } finally {
    await cleanupFiles(oggPath, wavPath)
  }
}

export async function voiceHandler(ctx: BotContext): Promise<void> {
  if (!env.SHERPA_SERVER_PATH) return

  const chatId = ctx.chat?.id
  if (!chatId) return

  const message = ctx.message
  if (!message || !('voice' in message) || !message.voice) return

  const threadId = message.message_thread_id
  const asrMode = getAsrMode(chatId)

  // ASR-only mode: transcribe and return text, don't send to AI
  if (asrMode !== 'off') {
    const text = await transcribeVoiceFile(message.voice.file_id, ctx.telegram)
    consumeAsrMode(chatId)

    if (!text) {
      await ctx.reply('❌ 語音辨識失敗，請重試。')
      return
    }

    await ctx.reply(`📝 ${text}`)
    return
  }

  // Normal mode: transcribe and send to AI
  const state = getUserState(chatId, threadId)

  if (!state.selectedProject) {
    await ctx.reply('用 /projects 選擇專案，或 /chat 進入通用對話模式。')
    return
  }

  const project = state.selectedProject
  const text = await transcribeVoiceFile(message.voice.file_id, ctx.telegram)

  if (!text) {
    await ctx.reply('❌ 語音辨識失敗，請重試。')
    return
  }

  recordActivity({
    timestamp: Date.now(),
    type: 'voice_sent',
    project: project.name,
    promptLength: text.length,
  })

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)
  enqueue({
    chatId,
    prompt: `[語音輸入] ${text}`,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })

  ctx.reply(`🎤 ${text}`).catch(() => {})
}
