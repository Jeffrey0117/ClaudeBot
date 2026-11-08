import { describe, it, expect } from 'vitest'
import {
  startDraft,
  finalizeDraft,
  cancelDraft,
  hasDraft,
  draftKeyFor,
} from '../../src/bot/draft-sender.js'

interface Edit {
  readonly messageId: number
  readonly text: string
}

function fakeTelegram() {
  let nextId = 100
  const edits: Edit[] = []
  const sent: string[] = []
  const telegram = {
    getChat: async () => ({ type: 'private' }),
    sendMessage: async (_chatId: number, text: string) => {
      sent.push(text)
      return { message_id: ++nextId }
    },
    editMessageText: async (
      _chatId: number,
      messageId: number,
      _inline: undefined,
      text: string,
    ) => {
      edits.push({ messageId, text })
      return true
    },
    deleteMessage: async () => true,
  }
  return { telegram, edits, sent }
}

type FakeTg = Parameters<typeof startDraft>[0]

/**
 * The queue runs one concurrent runner per project path, and they share a
 * chatId (/parallel, cross-project @run, auto project-switch). Draft state was
 * keyed by chatId alone, so the second runner overwrote the first's entry and
 * the first finalize deleted the shared state — the other runner's reply was
 * then dropped by `if (!state) return`, silently.
 */
describe('draft-sender concurrent runners in one chat', () => {
  it('keeps independent drafts per project', async () => {
    const { telegram } = fakeTelegram()
    const chatId = 7001
    const kA = draftKeyFor(chatId, 'C:/code/alpha')
    const kB = draftKeyFor(chatId, 'C:/code/beta')

    await startDraft(telegram as unknown as FakeTg, chatId, kA, 'alpha start')
    await startDraft(telegram as unknown as FakeTg, chatId, kB, 'beta start')

    expect(hasDraft(kA)).toBe(true)
    expect(hasDraft(kB)).toBe(true)

    cancelDraft(kA)
    cancelDraft(kB)
  })

  it('finalizing one runner leaves the other runner deliverable', async () => {
    const { telegram, edits } = fakeTelegram()
    const chatId = 7002
    const kA = draftKeyFor(chatId, 'C:/code/alpha')
    const kB = draftKeyFor(chatId, 'C:/code/beta')

    const idA = await startDraft(telegram as unknown as FakeTg, chatId, kA, 'alpha start')
    const idB = await startDraft(telegram as unknown as FakeTg, chatId, kB, 'beta start')
    expect(idA).not.toBe(idB)

    await finalizeDraft(telegram as unknown as FakeTg, chatId, kA, 'ALPHA-FINAL')
    expect(hasDraft(kA)).toBe(false)
    // the other runner must survive — this is the regression
    expect(hasDraft(kB)).toBe(true)

    await finalizeDraft(telegram as unknown as FakeTg, chatId, kB, 'BETA-FINAL')
    expect(hasDraft(kB)).toBe(false)

    // both answers were delivered, each to its own message
    const alpha = edits.find((e) => e.text.includes('ALPHA-FINAL'))
    const beta = edits.find((e) => e.text.includes('BETA-FINAL'))
    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()
    expect(alpha!.messageId).toBe(idA)
    expect(beta!.messageId).toBe(idB)
  })

  it('separates threads within the same chat and project', () => {
    expect(draftKeyFor(1, '/p', 11)).not.toBe(draftKeyFor(1, '/p', 22))
    expect(draftKeyFor(1, '/p')).toBe(draftKeyFor(1, '/p'))
  })
})
