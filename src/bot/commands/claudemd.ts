import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { getAISessionId } from '../../ai/session-store.js'
import { resolveBackend } from '../../ai/types.js'
import { enqueue } from '../../claude/queue.js'
import { getPairing, remoteProjectPath } from '../../remote/pairing-store.js'

const CLAUDEMD_PROMPT = [
  '請掃描此專案並生成或更新 CLAUDE.md。',
  '',
  '步驟：',
  '1. 讀取目錄結構（忽略 node_modules, .git, dist, .next）',
  '2. 讀取 package.json / Cargo.toml / pyproject.toml 等了解技術棧',
  '3. 掃描 src/ 下的主要模組，理解架構',
  '4. 如果已有 CLAUDE.md，讀取並保留好的內容，更新過時的部分',
  '5. 如果沒有，從頭生成',
  '',
  'CLAUDE.md 格式要求：',
  '- 開頭一句話描述專案',
  '- ## Stack — 技術棧（runtime, framework, key deps）',
  '- ## Architecture — 目錄結構 + 每個模組一句話說明',
  '- ## Key patterns — 關鍵設計模式（queue, session, auth 等）',
  '- ## Coding rules — 編碼慣例（從現有程式碼推斷）',
  '- ## Commands — 可用指令/API/CLI（如有）',
  '',
  '風格規則：',
  '- 簡潔精實，每段用最少文字傳達最多資訊',
  '- 用 inline code 標記路徑和變數名',
  '- 表格和清單優先，避免長段落',
  '- 不要寫「這是一個...」之類的廢話',
  '- 總長度控制在 100-200 行',
].join('\n')

export async function claudemdCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)
  const pairing = getPairing(chatId, threadId, state.activeMachine)
  const project = state.selectedProject
    ?? (pairing?.connected ? { name: 'remote', path: remoteProjectPath(pairing.label) } : null)

  if (!project) {
    await ctx.reply('⚠️ 尚未選擇專案。請先用 /projects 或 /pair。')
    return
  }

  const resolvedBackend = resolveBackend(state.ai.backend)
  const sessionId = getAISessionId(resolvedBackend, project.path)

  enqueue({
    chatId,
    prompt: CLAUDEMD_PROMPT,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })

  await ctx.reply(`📝 正在為 *${project.name}* 生成/更新 CLAUDE.md…`, { parse_mode: 'Markdown' })
}
