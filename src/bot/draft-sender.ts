import type { Telegraf } from 'telegraf'
import type { BotContext } from '../types/context.js'

/**
 * Strip [CTX]...[/CTX] blocks from streaming text before displaying in Telegram.
 * Handles both complete blocks and partial (mid-stream) blocks where only
 * the opening tag has arrived but the closing tag hasn't yet.
 */
function stripCtxForDisplay(text: string): string {
  // Strip complete [CTX]...[/CTX] blocks (with or without brackets)
  let result = text.replace(/\n?\[?CTX\]?\s*\n[\s\S]*?\n\s*\[?\/CTX\]?\s*$/g, '')

  // Strip partial (streaming) — opening tag seen but no closing tag yet
  // e.g. "[CTX]\nstatus: working on..." or "CTX\nstatus:..."
  result = result.replace(/\n?\[?CTX\]?\s*\n(?:status:[\s\S]*)$/g, '')

  return result.trimEnd()
}

/**
 * Draft message streaming state
 */
interface DraftState {
  /** Telegram message_id of the draft */
  readonly messageId: number
  /** Last sent text (to avoid duplicate updates) */
  lastText: string
  /** Timestamp of last update (for throttling) */
  lastUpdate: number
  /** Is this a private chat? */
  readonly isPrivate: boolean
}

const activeDrafts = new Map<number, DraftState>()

/** Minimum interval between draft updates (ms) */
const THROTTLE_MS = 300

/** Minimum text change required to trigger update (chars) */
const MIN_DELTA = 20

/**
 * Check if a chat is private (DM) or group/channel
 */
async function checkChatType(
  telegram: Telegraf<BotContext>['telegram'],
  chatId: number,
): Promise<'private' | 'group'> {
  try {
    const chat = await telegram.getChat(chatId)
    return chat.type === 'private' ? 'private' : 'group'
  } catch {
    // Default to group behavior if check fails
    return 'group'
  }
}

/**
 * Start a draft message stream (private chat only)
 * Returns message_id to use for subsequent updates
 */
export async function startDraft(
  telegram: Telegraf<BotContext>['telegram'],
  chatId: number,
  initialText: string,
): Promise<number | null> {
  try {
    const chatType = await checkChatType(telegram, chatId)
    if (chatType !== 'private') {
      // Groups don't support draft mode
      return null
    }

    // Send initial message that will be edited as content streams in
    const displayText = stripCtxForDisplay(initialText) || '...'
    const result = await telegram.sendMessage(chatId, displayText, {
      parse_mode: 'Markdown',
    })

    activeDrafts.set(chatId, {
      messageId: result.message_id,
      lastText: initialText,
      lastUpdate: Date.now(),
      isPrivate: true,
    })

    return result.message_id
  } catch (err) {
    console.error('[draft] startDraft failed:', err)
    return null
  }
}

/**
 * Update an active draft message (throttled)
 */
export async function updateDraft(
  telegram: Telegraf<BotContext>['telegram'],
  chatId: number,
  newText: string,
): Promise<void> {
  const state = activeDrafts.get(chatId)
  if (!state || !state.isPrivate) return

  // Throttle: skip if too soon or text change too small
  const now = Date.now()
  const timeDiff = now - state.lastUpdate
  const textDiff = Math.abs(newText.length - state.lastText.length)

  if (timeDiff < THROTTLE_MS && textDiff < MIN_DELTA) {
    return
  }

  const displayText = stripCtxForDisplay(newText) || '...'

  // Skip update if display text hasn't meaningfully changed after stripping
  if (displayText === state.lastText) return

  try {
    await telegram.editMessageText(
      chatId, state.messageId, undefined,
      displayText,
      { parse_mode: 'Markdown' },
    )

    state.lastText = displayText
    state.lastUpdate = now
  } catch (err) {
    // Silently ignore update errors (user experience degrades gracefully)
    // console.error('[draft] updateDraft failed:', err)
  }
}

/**
 * Finalize a draft by sending the complete message
 * (this replaces the draft with a real message)
 */
export async function finalizeDraft(
  telegram: Telegraf<BotContext>['telegram'],
  chatId: number,
  finalText: string,
): Promise<void> {
  const state = activeDrafts.get(chatId)
  if (!state) return

  try {
    // Edit the draft message with final clean content
    await telegram.editMessageText(
      chatId, state.messageId, undefined,
      finalText,
      { parse_mode: 'Markdown' },
    )
  } catch {
    // Fallback: edit without Markdown
    try {
      await telegram.editMessageText(chatId, state.messageId, undefined, finalText)
    } catch {
      // Edit failed — delete dirty draft so CTX/partial text doesn't linger
      await telegram.deleteMessage(chatId, state.messageId).catch(() => {})
      // Send clean text as new message
      await telegram.sendMessage(chatId, finalText).catch(() => {})
    }
  } finally {
    activeDrafts.delete(chatId)
  }
}

/**
 * Cancel a draft (cleanup state without sending final message)
 */
export function cancelDraft(chatId: number): void {
  activeDrafts.delete(chatId)
}

/**
 * Check if a draft is active for a chat
 */
export function hasDraft(chatId: number): boolean {
  return activeDrafts.has(chatId)
}
