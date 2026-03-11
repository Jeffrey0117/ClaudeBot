/**
 * Voice message handler.
 * Downloads OGG → ffmpeg → 16 kHz WAV → Sherpa ASR → biaodian punctuation.
 *
 * Non-blocking Gemini refinement:
 * 1. Show punctuated text immediately with ⚡ indicator
 * 2. Resolve buffer → queue proceeds without waiting
 * 3. Background: Gemini refines → edit message, ⚡ removed
 * 4. If Gemini fails or overloaded (≥2 voices), ⚡ stays
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
import { transcribeAudio, isSherpaAvailable, PYTHON_EXE } from '../../asr/sherpa-client.js'
import ffmpegPath from 'ffmpeg-static'
import { env } from '../../config/env.js'
import { getAsrMode, consumeAsrMode } from '../asr-store.js'
import { addVoice, getVoiceActive } from '../ordered-message-buffer.js'
import { telegramFetch } from '../../utils/telegram-fetch.js'
import { getPairing } from '../../remote/pairing-store.js'

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
interface RefineResult {
  readonly result: string | null
  readonly debug: string
}

// Resolve gemini CLI — use Node to run the JS entry directly on Windows
// to avoid cmd.exe escaping issues with Chinese text
function resolveGeminiEntry(): string {
  if (process.platform !== 'win32') return 'gemini'
  const jsEntry = join(
    process.env.APPDATA || '', 'npm', 'node_modules',
    '@google', 'gemini-cli', 'dist', 'index.js',
  )
  if (existsSync(jsEntry)) return jsEntry
  return join(process.env.APPDATA || '', 'npm', 'gemini.cmd')
}

const GEMINI_ENTRY = resolveGeminiEntry()

async function refineWithLLM(rawText: string): Promise<RefineResult> {
  const t0 = Date.now()
  try {
    const prompt = `${REFINE_PROMPT}\n\n原始文字：${rawText}`

    // Run gemini: on Windows use node + JS entry to bypass cmd.exe
    const isJsEntry = GEMINI_ENTRY.endsWith('.js')
    const command = isJsEntry ? process.execPath : GEMINI_ENTRY
    const args = isJsEntry
      ? [GEMINI_ENTRY, '-p', prompt]
      : ['-p', prompt]

    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: 'utf-8',
      timeout: 30_000,
      windowsHide: true,
    })

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const debugParts = [`${elapsed}s`, `stdout=${stdout.length}c`, `stderr=${stderr.length}c`]
    // Strip Gemini CLI preamble lines (e.g. "Loaded cached credentials.")
    const lines = stdout.split('\n').filter(
      (l) => l.trim() && !l.includes('credentials') && !l.includes('Hook registry'),
    )
    const refined = lines.join('\n').trim()
    debugParts.push(`filtered=${refined.length}c`)
    if (!refined) {
      return { result: null, debug: `empty after filter. ${debugParts.join(',')}` }
    }
    if (refined.length > rawText.length * 3) {
      return { result: null, debug: `too long (${refined.length}>${rawText.length}*3). ${debugParts.join(',')}` }
    }
    return { result: refined, debug: `${isJsEntry ? 'node' : 'cmd'}. ${debugParts.join(',')}` }
  } catch (err: unknown) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const execErr = err as { message?: string; stderr?: string; code?: string | number; killed?: boolean }
    const stderr = execErr.stderr?.trim().slice(0, 120) || ''
    const code = execErr.killed ? 'TIMEOUT' : (execErr.code ?? '')
    const msg = execErr.message?.slice(0, 60) || String(err).slice(0, 60)
    return { result: null, debug: `FAIL[${code}][${elapsed}s]: ${msg} | stderr: ${stderr}` }
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
 * Zero-latency pure-regex approach — ideal when degrading from Gemini.
 */
async function addPunctuation(text: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(PYTHON_EXE, [BIAODIAN_PATH, text], {
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

/**
 * Break long ASR text into paragraphs for readability.
 * Inserts line breaks after sentence-ending punctuation (。！？；).
 */
function formatAsrText(text: string): string {
  return text.replace(/([。！？；])\s*/g, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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
export interface VoiceResult {
  readonly text: string | null
  readonly rawText?: string
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
    const [fileLink] = await Promise.all([
      telegram.getFileLink(fileId),
      ensureTempDir(),
    ])
    const buffer = await telegramFetch(fileLink.href)
    await writeFile(oggPath, buffer)

    try {
      await execFileAsync(ffmpegPath ?? 'ffmpeg', [
        '-i', oggPath,
        '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath,
      ], { timeout: 30_000 })
    } catch (ffErr) {
      console.error('[voice] ffmpeg error:', ffErr)
      return { text: null, error: 'ffmpeg 轉檔失敗' }
    }

    const result = await transcribeAudio(wavPath)
    if (!result.success || !result.text) {
      return { text: null, error: `辨識失敗${result.error ? `: ${result.error}` : ''}` }
    }
    const rawText = result.text.trim()
    const punctuated = await addPunctuation(rawText)
    return { text: punctuated, rawText }
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
    await ctx.reply('🎙️ 語音辨識未啟用。\n需要安裝 Sherpa ASR：github.com/Jeffrey0117/Sherpa_ASR')
    return
  }

  const chatId = ctx.chat?.id
  if (!chatId) return

  const message = ctx.message
  if (!message || !('voice' in message) || !message.voice) return

  const messageId = message.message_id
  const threadId = message.message_thread_id
  const asrMode = getAsrMode(chatId)

  console.error(`[voice] handler entered: chatId=${chatId}, asrMode=${asrMode}`)

  if (!hasProjectOrAsrMode(chatId, threadId, asrMode)) {
    await ctx.reply('用 /projects 選擇專案，或 /chat 進入通用對話模式。')
    return
  }

  // ASR-only mode — bypass buffer, process directly
  if (asrMode !== 'off') {
    const ackMsg = await ctx.reply('🎙️ 處理中...')
    const fileId = message.voice.file_id
    const { telegram } = ctx

    processAsrOnly(telegram, chatId, fileId, ackMsg.message_id).catch((err) => {
      console.error('[voice] ASR-only error:', err)
    })
    return
  }

  // Normal mode — register in ordered buffer, then process in background
  const state = getUserState(chatId, threadId)
  if (!state.selectedProject && !getPairing(chatId, threadId)?.connected) return

  const voiceActive = getVoiceActive(chatId, threadId)
  const ackText = voiceActive === 0
    ? '🎙️ 處理中...'
    : `🎙️ 已收到，前面 ${voiceActive} 條語音處理中`
  const ackMsg = await ctx.reply(ackText)

  const resolveVoice = addVoice(chatId, messageId, threadId)
  const fileId = message.voice.file_id
  const { telegram } = ctx

  processVoiceInBackground(
    telegram, chatId, threadId, fileId, ackMsg.message_id, resolveVoice,
  ).catch((err) => {
    console.error('[voice] background error:', err)
  })
}

/** Quick check: ASR mode on, or selected project, or active remote pairing. */
function hasProjectOrAsrMode(
  chatId: number, threadId: number | undefined, asrMode: string,
): boolean {
  if (asrMode !== 'off') return true
  const state = getUserState(chatId, threadId)
  if (state.selectedProject) return true
  const pairing = getPairing(chatId, threadId)
  return pairing?.connected === true
}

/** ASR-only mode: transcribe and reply directly, no buffer. */
async function processAsrOnly(
  telegram: BotContext['telegram'],
  chatId: number,
  fileId: string,
  ackMsgId: number,
): Promise<void> {
  const deleteAck = () => telegram.deleteMessage(chatId, ackMsgId).catch(() => {})

  const result = await transcribeVoiceFile(fileId, telegram)

  consumeAsrMode(chatId)
  deleteAck()

  if (!result.text) {
    await telegram.sendMessage(chatId,
      `❌ 語音辨識失敗${result.error ? `：${result.error}` : '，請重試'}`,
    )
    return
  }

  const formatted = formatAsrText(result.text)
  await telegram.sendMessage(chatId,
    `📝 辨識結果：\n\`\`\`\n${formatted}\n\`\`\`\n💡 _點擊上方文字可複製_`,
    { parse_mode: 'Markdown' },
  )
}

/**
 * Normal mode: ASR → show immediately with ⚡ → resolve buffer →
 * background Gemini refinement → edit message to remove ⚡.
 */
async function processVoiceInBackground(
  telegram: BotContext['telegram'],
  chatId: number,
  threadId: number | undefined,
  fileId: string,
  ackMsgId: number,
  resolveVoice: (text: string | null) => void,
): Promise<void> {
  const deleteAck = () => telegram.deleteMessage(chatId, ackMsgId).catch(() => {})

  const result = await transcribeVoiceFile(fileId, telegram)

  deleteAck()

  if (!result.text) {
    resolveVoice(null)
    telegram.sendMessage(chatId,
      `❌ 語音辨識失敗${result.error ? `：${result.error}` : '，已跳過'}`,
    ).catch(() => {})
    return
  }

  // Show punctuated text immediately with ⚡ (pending Gemini refinement)
  const formatted = formatAsrText(result.text)
  const sentMsg = await telegram.sendMessage(chatId, `🗣⚡ ${formatted}`)
    .catch(() => null)

  // Resolve buffer immediately — don't block queue
  resolveVoice(result.text)

  // Background: Gemini refinement → edit message silently
  if (sentMsg) {
    const rawText = result.rawText ?? result.text
    enqueueRefinement(telegram, chatId, sentMsg.message_id, rawText)
  }
}

/** Semaphore: max 1 concurrent Gemini refinement to avoid resource contention with Claude CLI. */
let geminiRunning = false

/** Queue a Gemini refinement. Skips if one is already running — task execution takes priority. */
function enqueueRefinement(
  telegram: BotContext['telegram'],
  chatId: number,
  messageId: number,
  rawText: string,
): void {
  if (geminiRunning) return  // skip — ⚡ stays, don't compete with Claude CLI
  geminiRunning = true
  refineWithLLM(rawText).then(({ result: refined }) => {
    if (refined) {
      const formatted = formatAsrText(refined)
      telegram.editMessageText(chatId, messageId, undefined, `🗣 ${formatted}`)
        .catch(() => {})
    }
  }).catch(() => {}).finally(() => {
    geminiRunning = false
  })
}
