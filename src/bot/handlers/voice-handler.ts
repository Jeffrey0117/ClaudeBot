/**
 * Voice message handler.
 * Downloads OGG → ffmpeg converts to 16 kHz WAV (2x speed) → Sherpa ASR →
 * LLM refinement (fix typos/grammar) → enqueue as prompt.
 */

import { execFile } from 'node:child_process'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { resolveBackend } from '../../ai/types.js'
import { getAISessionId } from '../../ai/session-store.js'
import { enqueue } from '../../claude/queue.js'
import { transcribeAudio, isSherpaAvailable } from '../../asr/sherpa-client.js'
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
      '-p', prompt,
    ], { encoding: 'utf-8', timeout: 15_000, windowsHide: true })
    // Strip Gemini CLI preamble lines (e.g. "Loaded cached credentials.")
    const lines = stdout.split('\n').filter(
      (l) => l.trim() && !l.includes('credentials') && !l.includes('Hook registry'),
    )
    const refined = lines.join('\n').trim()
    if (!refined || refined.length > rawText.length * 3) return null
    console.log(`[voice] gemini OK: "${refined.slice(0, 60)}"`)
    return refined
  } catch (err) {
    console.error('[voice] gemini FAIL:', err)
    return null
  }
}
function resolveBiaodianPath(): string {
  if (env.BIAODIAN_PATH) return env.BIAODIAN_PATH
  const sherpaAsr = join(process.cwd(), '..', 'Sherpa_ASR', 'punctuation.py')
  if (existsSync(sherpaAsr)) return sherpaAsr
  return join(process.cwd(), '..', 'biaodian', 'biaodian.py')
}

const BIAODIAN_PATH = resolveBiaodianPath()

/**
 * Add punctuation using the biaodian rule-based tool.
 * Zero-latency pure-regex approach — ideal as a pre-processing step.
 */
async function addPunctuation(text: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('python', [BIAODIAN_PATH, text], {
      encoding: 'utf-8',
      timeout: 3_000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    const result = stdout.trim()
    return result || text
  } catch {
    return text
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
 * Audio is played at 2x speed before ASR — keeps accuracy while halving processing time.
 * Returns the transcribed text, or null on failure.
 * Reusable by both voiceHandler and reply-quote extraction.
 */
export interface VoiceResult {
  readonly text: string | null
  readonly error?: string
}

export async function transcribeVoiceFile(
  fileId: string,
  telegram: BotContext['telegram'],
): Promise<VoiceResult> {
  if (!isSherpaAvailable()) {
    console.error('[voice] Sherpa not available')
    return { text: null, error: 'Sherpa ASR 未啟動' }
  }

  const id = randomUUID()
  const oggPath = join(TEMP_DIR, `${id}.ogg`)
  const wavPath = join(TEMP_DIR, `${id}.wav`)

  try {
    console.log('[voice] downloading file...')
    const [fileLink] = await Promise.all([
      telegram.getFileLink(fileId),
      ensureTempDir(),
    ])
    const response = await fetch(fileLink.href, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) {
      console.error('[voice] fetch failed:', response.status)
      return { text: null, error: `下載失敗 (${response.status})` }
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    await writeFile(oggPath, buffer)
    console.log('[voice] ffmpeg converting...')

    try {
      await execFileAsync('ffmpeg', [
        '-i', oggPath,
        '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath,
      ], { timeout: 30_000 })
    } catch (ffErr) {
      console.error('[voice] ffmpeg error:', ffErr)
      return { text: null, error: 'ffmpeg 轉檔失敗' }
    }

    console.log('[voice] transcribing...')
    const result = await transcribeAudio(wavPath)
    console.log('[voice] result:', JSON.stringify(result).slice(0, 200))
    if (!result.success || !result.text) {
      return { text: null, error: `辨識失敗${result.error ? `: ${result.error}` : ''}` }
    }
    const rawText = result.text.trim()

    const refined = await refineWithLLM(rawText)
    console.log(`[voice] raw: ${rawText.slice(0, 80)}`)
    console.log(`[voice] refined: ${refined?.slice(0, 80) ?? '(failed)'}`)
    return { text: refined ?? rawText }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[voice] ERROR:', err)
    return { text: null, error: msg }
  } finally {
    await cleanupFiles(oggPath, wavPath)
  }
}

export async function voiceHandler(ctx: BotContext): Promise<void> {
  if (!isSherpaAvailable()) {
    await ctx.reply('\u{1F399}\u{FE0F} \u{8A9E}\u{97F3}\u{8FA8}\u{8B58}\u{672A}\u{555F}\u{7528}\u{3002}\n\u{9700}\u{8981}\u{5B89}\u{88DD} Sherpa ASR\uFF1Agithub.com/Jeffrey0117/Sherpa_ASR')
    return
  }

  const chatId = ctx.chat?.id
  if (!chatId) return

  const message = ctx.message
  if (!message || !('voice' in message) || !message.voice) return

  const threadId = message.message_thread_id
  const asrMode = getAsrMode(chatId)

  if (!state_selectedProjectOrAsrMode(chatId, threadId, asrMode)) {
    await ctx.reply('\u{7528} /projects \u{9078}\u{64C7}\u{5C08}\u{6848}\uFF0C\u{6216} /chat \u{9032}\u{5165}\u{901A}\u{7528}\u{5C0D}\u{8A71}\u{6A21}\u{5F0F}\u{3002}')
    return
  }

  // Non-blocking: acknowledge immediately, process in background
  const ackMsg = await ctx.reply('\u{1F399}\u{FE0F} \u{8655}\u{7406}\u{4E2D}...')

  // Capture everything needed, then release the middleware chain
  const fileId = message.voice.file_id
  const { telegram } = ctx

  processVoiceInBackground(
    telegram, chatId, threadId, fileId, asrMode, ackMsg.message_id,
  ).catch((err) => {
    console.error('[voice] background error:', err)
  })
}

/** Quick check: either ASR mode is on, or user has a selected project. */
function state_selectedProjectOrAsrMode(
  chatId: number, threadId: number | undefined, asrMode: string,
): boolean {
  if (asrMode !== 'off') return true
  const state = getUserState(chatId, threadId)
  return state.selectedProject !== null
}

async function processVoiceInBackground(
  telegram: BotContext['telegram'],
  chatId: number,
  threadId: number | undefined,
  fileId: string,
  asrMode: string,
  ackMsgId: number,
): Promise<void> {
  const deleteAck = () => telegram.deleteMessage(chatId, ackMsgId).catch(() => {})

  const result = await transcribeVoiceFile(fileId, telegram)

  // ASR-only mode
  if (asrMode !== 'off') {
    consumeAsrMode(chatId)
    deleteAck()

    if (!result.text) {
      await telegram.sendMessage(chatId,
        `\u{274C} \u{8A9E}\u{97F3}\u{8FA8}\u{8B58}\u{5931}\u{6557}${result.error ? `\uFF1A${result.error}` : '\uFF0C\u{8ACB}\u{91CD}\u{8A66}'}`,
      )
      return
    }

    const punctuated = await addPunctuation(result.text)
    await telegram.sendMessage(chatId,
      `\u{1F4DD} \u{8FA8}\u{8B58}\u{7D50}\u{679C}\uFF1A\n\`\`\`\n${punctuated}\n\`\`\`\n\u{1F4A1} _\u{9EDE}\u{64CA}\u{4E0A}\u{65B9}\u{6587}\u{5B57}\u{53EF}\u{8907}\u{88FD}_`,
      { parse_mode: 'Markdown' },
    )
    return
  }

  // Normal mode: transcribe → enqueue to AI
  const state = getUserState(chatId, threadId)
  if (!state.selectedProject) {
    deleteAck()
    return
  }

  if (!result.text) {
    deleteAck()
    await telegram.sendMessage(chatId,
      `\u{274C} \u{8A9E}\u{97F3}\u{8FA8}\u{8B58}\u{5931}\u{6557}${result.error ? `\uFF1A${result.error}` : '\uFF0C\u{8ACB}\u{91CD}\u{8A66}'}`,
    )
    return
  }

  const project = state.selectedProject
  const text = result.text

  recordActivity({
    timestamp: Date.now(),
    type: 'voice_sent',
    project: project.name,
    promptLength: text.length,
  })

  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)
  enqueue({
    chatId,
    prompt: `[\u{8A9E}\u{97F3}\u{8F38}\u{5165}] ${text}`,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })

  deleteAck()
  telegram.sendMessage(chatId, `\u{1F5E3} ${text}`).catch(() => {})
}
