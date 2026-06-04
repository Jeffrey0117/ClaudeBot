import type { BotContext } from '../types/context.js'
import { restartProject, rollbackProject } from './cloudpipe-client.js'
import { findProject } from '../config/projects.js'
import { getUserState, setUserProject } from './state.js'
import { enqueue } from '../claude/queue.js'
import { resolveBackend } from '../ai/types.js'
import { getAISessionId } from '../ai/session-store.js'

/**
 * Inline-button callbacks for the ops router:
 *   cp_restart:<id>   — confirmed restart
 *   cp_rollback:<id>  — confirmed rollback
 *   cp_fix:<id>       — deploy-failure one-tap fix (the ONLY path that uses Claude)
 *   cp_cancel         — dismiss a confirm prompt
 *
 * Returns true when the callback was handled (so the bot's callback chain stops).
 */
export async function handleOpsCallback(ctx: BotContext, data: string): Promise<boolean> {
  if (!data.startsWith('cp_')) return false

  if (data === 'cp_cancel') {
    await safeAnswer(ctx, '已取消')
    await safeEdit(ctx, '❌ 已取消')
    return true
  }

  const [action, projectId] = data.split(':')

  if (action === 'cp_restart' && projectId) {
    await safeAnswer(ctx, '重啟中…')
    const res = await restartProject(projectId)
    await safeEdit(
      ctx,
      res.ok ? `✅ ${projectId} 已重啟` : `❌ 重啟失敗:${res.error ?? '未知錯誤'}`
    )
    return true
  }

  if (action === 'cp_rollback' && projectId) {
    await safeAnswer(ctx, '回滾中…')
    const res = await rollbackProject(projectId)
    await safeEdit(
      ctx,
      res.ok ? `↩️ ${projectId} 已回滾到上一版` : `❌ 回滾失敗:${res.error ?? '未知錯誤'}`
    )
    return true
  }

  if (action === 'cp_fix' && projectId) {
    return handleFix(ctx, projectId)
  }

  return false
}

/**
 * One-tap deploy-failure fix: enqueue a Claude task scoped to the failed
 * project. This deliberately DOES use Claude — but only when the user taps it.
 */
async function handleFix(ctx: BotContext, projectId: string): Promise<boolean> {
  const chatId = ctx.chat?.id
  if (!chatId) return true

  const project = findProject(projectId)
  if (!project) {
    await safeAnswer(ctx, '找不到本地專案')
    await safeEdit(ctx, `⚠️ 找不到 ${projectId} 的本地程式碼,無法自動修。`)
    return true
  }

  const threadId =
    ctx.callbackQuery?.message && 'message_thread_id' in ctx.callbackQuery.message
      ? ctx.callbackQuery.message.message_thread_id
      : undefined

  setUserProject(chatId, project, threadId)
  const state = getUserState(chatId, threadId)
  const sessionId = getAISessionId(resolveBackend(state.ai.backend), project.path)

  enqueue({
    chatId,
    threadId,
    prompt:
      `CloudPipe 上「${projectId}」最近一次部署失敗了。請:\n` +
      `1. 用 mcp__cloudpipe__get_deployments 或 get_logs 看失敗原因\n` +
      `2. 在本地 repo 診斷並修復\n` +
      `3. 修好後用 /deploy 重新部署\n` +
      `先簡短說明你判斷的原因再動手。`,
    project,
    ai: state.ai,
    sessionId,
    imagePaths: [],
  })

  await safeAnswer(ctx, '已交給 Claude 修')
  await safeEdit(ctx, `🔧 已交給 Claude 診斷並修復 *${projectId}* 的部署…`)
  return true
}

async function safeAnswer(ctx: BotContext, text: string): Promise<void> {
  try {
    await ctx.answerCbQuery(text)
  } catch {
    // callback may already be answered / expired
  }
}

async function safeEdit(ctx: BotContext, text: string): Promise<void> {
  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown' })
  } catch {
    // message may be uneditable; best-effort fallback
    try {
      await ctx.reply(text, { parse_mode: 'Markdown' })
    } catch {
      // give up silently
    }
  }
}
