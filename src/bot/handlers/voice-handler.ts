/**
 * Voice message handler.
 * Downloads OGG → ffmpeg converts to 16 kHz WAV → Sherpa ASR →
 * LLM refinement (fix typos/grammar) → enqueue as prompt.
 *
 * Long audio (>25s) is split into ~20s chunks for faster processing.
 */

import { execFile } from 'node:child_process'
import { writeFile, unlink, mkdir, stat } from 'node:fs/promises'
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

/** Chunk threshold: audio longer than this gets split */
const CHUNK_THRESHOLD_S = 25
/** Each chunk duration in seconds */
const CHUNK_SIZE_S = 20

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
    ], { encoding: 'utf-8', timeout: 15_000, windowsHide: true })
    const refined = stdout.trim()
    // Sanity check: don't accept empty or absurdly different-length results
    if (!refined || refined.length > rawText.length * 3) return null
    return refined
  } catch {
    return null
  }
}
const BIAODIAN_PATH = join(process.cwd(), '..', 'biaodian', 'biaodian.py')

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

/** Get WAV duration from file size (16kHz mono 16-bit → 32000 bytes/sec) */
async function getWavDuration(wavPath: string): Promise<number> {
  const info = await stat(wavPath)
  const dataBytes = info.size - 44 // WAV header is 44 bytes
  return Math.max(0, dataBytes / (16000 * 2))
}

/** Split a WAV file into ~CHUNK_SIZE_S second chunks using ffmpeg */
async function splitIntoChunks(
  wavPath: string,
  duration: number,
  id: string,
): Promise<string[]> {
  const chunkPaths: string[] = []
  for (let start = 0; start < duration; start += CHUNK_SIZE_S) {
    const chunkPath = join(TEMP_DIR, `${id}_c${chunkPaths.length}.wav`)
    await execFileAsync('ffmpeg', [
      '-i', wavPath,
      '-ss', String(start),
      '-t', String(CHUNK_SIZE_S),
      '-ar', '16000', '-ac', '1', '-f', 'wav', '-y',
      chunkPath,
    ])
    chunkPaths.push(chunkPath)
  }
  return chunkPaths
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
  const extraFiles: string[] = []

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
      '-i', oggPath,
      '-filter:a', 'atempo=2.0',
      '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath,
    ])

    const duration = await getWavDuration(wavPath)

    let rawText: string

    if (duration > CHUNK_THRESHOLD_S) {
      // Long audio: split into chunks and transcribe each
      const chunkPaths = await splitIntoChunks(wavPath, duration, id)
      extraFiles.push(...chunkPaths)

      const texts: string[] = []
      for (const chunkPath of chunkPaths) {
        const result = await transcribeAudio(chunkPath)
        if (result.success && result.text) {
          texts.push(result.text.trim())
        }
      }

      if (texts.length === 0) return null
      rawText = texts.join('')
    } else {
      // Short audio: transcribe directly
      const result = await transcribeAudio(wavPath)
      if (!result.success || !result.text) return null
      rawText = result.text.trim()
    }

    const refined = await refineWithLLM(rawText)
    return refined ?? rawText
  } catch {
    return null
  } finally {
    await cleanupFiles(oggPath, wavPath, ...extraFiles)
  }
}

export async function voiceHandler(ctx: BotContext): Promise<void> {
  if (!env.SHERPA_SERVER_PATH) return

  const chatId = ctx.chat?.id
  if (!chatId) return

  const message = ctx.message
  if (!message || !('voice' in message) || !message.voice) return

  const duration = message.voice.duration ?? 0
  const threadId = message.message_thread_id
  const asrMode = getAsrMode(chatId)

  // Warn for long audio
  if (duration > CHUNK_THRESHOLD_S) {
    ctx.reply(`\u{23F3} \u{8F03}\u{9577}\u{8A9E}\u{97F3} (${duration}s)\uFF0C\u{5206}\u{6BB5}\u{8655}\u{7406}\u{4E2D}...`).catch(() => {})
  }

  // ASR-only mode: transcribe → biaodian punctuation → LLM refine → return text
  // Higher quality pipeline since user specifically wants the text output.
  if (asrMode !== 'off') {
    const text = await transcribeVoiceFile(message.voice.file_id, ctx.telegram)
    consumeAsrMode(chatId)

    if (!text) {
      await ctx.reply('\u{274C} \u{8A9E}\u{97F3}\u{8FA8}\u{8B58}\u{5931}\u{6557}\uFF0C\u{8ACB}\u{91CD}\u{8A66}\u{3002}')
      return
    }

    // Extra step: ensure punctuation even if LLM refinement skipped it
    const punctuated = await addPunctuation(text)

    await ctx.reply(`\u{1F4DD} \u{8FA8}\u{8B58}\u{7D50}\u{679C}\uFF1A\n\`\`\`\n${punctuated}\n\`\`\`\n\u{1F4A1} _\u{9EDE}\u{64CA}\u{4E0A}\u{65B9}\u{6587}\u{5B57}\u{53EF}\u{8907}\u{88FD}_`, { parse_mode: 'Markdown' })
    return
  }

  // Normal mode: transcribe and send to AI
  const state = getUserState(chatId, threadId)

  if (!state.selectedProject) {
    await ctx.reply('\u{7528} /projects \u{9078}\u{64C7}\u{5C08}\u{6848}\uFF0C\u{6216} /chat \u{9032}\u{5165}\u{901A}\u{7528}\u{5C0D}\u{8A71}\u{6A21}\u{5F0F}\u{3002}')
    return
  }

  const project = state.selectedProject
  const text = await transcribeVoiceFile(message.voice.file_id, ctx.telegram)

  if (!text) {
    await ctx.reply('\u{274C} \u{8A9E}\u{97F3}\u{8FA8}\u{8B58}\u{5931}\u{6557}\uFF0C\u{8ACB}\u{91CD}\u{8A66}\u{3002}')
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
    prompt: `[\u{8A9E}\u{97F3}\u{8F38}\u{5165}] ${text}`,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })

  ctx.reply(`\u{1F3A4} ${text}`).catch(() => {})
}
