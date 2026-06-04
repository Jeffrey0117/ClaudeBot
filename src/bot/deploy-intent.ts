import type { BotContext } from '../types/context.js'
import { getUserState, setUserProject } from './state.js'
import { findProject } from '../config/projects.js'
import { deployCommand } from './commands/deploy.js'
import { getProject, type CloudPipeDeployment } from './cloudpipe-client.js'

/**
 * Deploy-intent router.
 *
 * Why: deploying through natural language makes ClaudeBot spin up a Claude CLI
 * turn just to re-discover "how do we deploy" every time — burning quota and
 * tripping the Anthropic ~15-min rate-limit cooldown. The `/deploy` command
 * already encodes the full deploy flow (commit + push + CloudPipe sync) without
 * touching Claude. This router detects a terse "部署 …" / "deploy …" command and
 * runs `/deploy` directly, bypassing Claude entirely.
 *
 * Conservative by design: only fires on an imperative that STARTS with a deploy
 * verb and is NOT phrased as a question, so "怎麼部署?" / "deploy 設定在哪" fall
 * through to Claude untouched.
 */

// Imperative deploy verbs at the very start of the message. No \b — Chinese has
// no word boundaries — so we anchor at ^ and consume an optional separator.
const DEPLOY_VERB = /^\s*(部署|佈署|布署|部屬|發佈|發布|上線|deploy)\s*[:：]?\s*/i

// If any of these appear, the user is ASKING about deployment, not commanding it.
const QUESTION_MARKERS = /[?？]|嗎|怎麼|怎樣|如何|為什麼|為何|哪裡|哪個|在哪|何時|可不可以|可以嗎|是不是|教學|說明|文件|設定/

export interface DeployIntent {
  /** Text after the verb — may hold "<project> <commit…>", "<commit…>", or "". */
  readonly rest: string
}

/**
 * Detect a terse deploy command. Returns null when the message is not a deploy
 * imperative (so the caller should let it flow to Claude as normal).
 */
export function detectDeployIntent(text: string): DeployIntent | null {
  const t = text.trim()
  // Terse imperative only — a long paragraph that happens to start with "部署"
  // is almost certainly prose, not a command.
  if (!t || t.length > 100) return null

  const match = DEPLOY_VERB.exec(t)
  if (!match) return null

  // Reject questions about deployment.
  if (QUESTION_MARKERS.test(t)) return null

  return { rest: t.slice(match[0].length).trim() }
}

function getThreadId(ctx: BotContext): number | undefined {
  return ctx.message && 'message_thread_id' in ctx.message
    ? ctx.message.message_thread_id
    : undefined
}

/**
 * Run a detected deploy intent directly via `/deploy`, bypassing Claude.
 * Returns true when the intent was consumed (deployed or answered), false when
 * the caller should fall through to the normal Claude pipeline.
 */
export async function runDeployFromIntent(
  ctx: BotContext,
  intent: DeployIntent
): Promise<boolean> {
  const chatId = ctx.chat?.id
  if (!chatId) return false
  const threadId = getThreadId(ctx)

  const rest = intent.rest
  let commitMsg = rest

  // If the first token resolves to a known project, treat it as the target and
  // the remainder as the commit message. Otherwise deploy the selected project
  // and use the whole rest as the commit message.
  const firstSpace = rest.search(/\s/)
  const firstToken = firstSpace === -1 ? rest : rest.slice(0, firstSpace)

  let targetProject = null
  if (firstToken) {
    targetProject = findProject(firstToken)
    if (targetProject) {
      commitMsg = firstSpace === -1 ? '' : rest.slice(firstSpace).trim()
    }
  }

  const selected = getUserState(chatId, threadId).selectedProject

  if (targetProject) {
    setUserProject(chatId, targetProject, threadId)
  } else if (!selected) {
    // Nothing named and nothing selected — answer directly (still no Claude).
    await ctx.reply(
      '🤔 要部署哪個專案?\n例如:`部署 makee`,或先用 /projects 選擇專案。',
      { parse_mode: 'Markdown' }
    )
    return true
  }

  const finalProject = targetProject ?? selected
  const finalCommit = commitMsg || `chore: 透過 Telegram 快速部署`

  try {
    await ctx.reply(
      `🚀 偵測到部署指令,直接執行 *${finalProject?.name}*(略過 Claude,省額度)…`,
      { parse_mode: 'Markdown' }
    )
  } catch {
    // best-effort notice; never block the deploy on a failed status message
  }

  await deployCommand(ctx, { commitOverride: finalCommit })

  // Fire-and-forget: follow the CloudPipe build and report the outcome here,
  // so the user doesn't have to ask "好了嗎?" — still no Claude involved.
  const projectId = finalProject?.name
  if (projectId) void trackDeploy(ctx, projectId)
  return true
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const TERMINAL = /^(deployed|success|failed|error|rolled_back|skipped|aborted)$/i
const FAILED = /^(failed|error)$/i

function latestDeployId(
  result: Awaited<ReturnType<typeof getProject>>
): string | null {
  if (!result.ok || !result.data) return null
  const d = result.data.deployments?.[0]
  return d?.id !== undefined && d?.id !== null ? String(d.id) : null
}

/**
 * Poll CloudPipe until a NEW deployment for this project reaches a terminal
 * state, then update a single status message. Best-effort: silently gives up if
 * CloudPipe is unreachable, and shows a gentle timeout note if nothing resolves.
 */
async function trackDeploy(ctx: BotContext, projectId: string): Promise<void> {
  try {
    const baseline = await getProject(projectId)
    if (baseline.notReady) return // CloudPipe unreachable — skip tracking entirely
    const baselineId = latestDeployId(baseline)

    const sent = await ctx.reply(`⏳ 追蹤 *${projectId}* 部署中…`, { parse_mode: 'Markdown' })
    const chatId = ctx.chat?.id
    const messageId = (sent as { message_id?: number })?.message_id

    for (let i = 0; i < 30; i++) {
      await sleep(6000)
      const cur = await getProject(projectId)
      if (!cur.ok || !cur.data) continue
      const latest = cur.data.deployments?.[0]
      if (!latest || latest.id === undefined || latest.id === null) continue

      const isNew = String(latest.id) !== String(baselineId)
      if (isNew && TERMINAL.test(String(latest.status))) {
        await finalize(ctx, chatId, messageId, projectId, latest)
        return
      }
    }
    await editStatus(
      ctx,
      chatId,
      messageId,
      `ℹ️ ${projectId} 部署追蹤逾時。輸入「${projectId} 狀態」查最新結果。`
    )
  } catch {
    // tracking is best-effort; never throw into the bot loop
  }
}

async function finalize(
  ctx: BotContext,
  chatId: number | undefined,
  messageId: number | undefined,
  projectId: string,
  deployment: CloudPipeDeployment
): Promise<void> {
  const commit = deployment.commit ? String(deployment.commit).slice(0, 7) : '—'
  const status = String(deployment.status || '').toLowerCase()

  if (FAILED.test(status)) {
    const reason = deployment.error ? `\n原因:${String(deployment.error).slice(0, 200)}` : ''
    await editStatus(
      ctx,
      chatId,
      messageId,
      `❌ *${projectId}* 部署失敗(commit \`${commit}\`)${reason}`,
      {
        inline_keyboard: [
          [
            { text: '🔧 用 Claude 修', callback_data: `cp_fix:${projectId}` },
            { text: '📋 看 log', callback_data: 'cp_cancel' },
          ],
        ],
      }
    )
    return
  }

  if (/^(skipped|aborted)$/i.test(status)) {
    await editStatus(ctx, chatId, messageId, `⚠️ *${projectId}* 部署略過(${status})`)
    return
  }

  await editStatus(ctx, chatId, messageId, `✅ *${projectId}* 上線了!commit \`${commit}\``)
}

interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

async function editStatus(
  ctx: BotContext,
  chatId: number | undefined,
  messageId: number | undefined,
  text: string,
  markup?: InlineKeyboard
): Promise<void> {
  try {
    if (chatId && messageId) {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: 'Markdown',
        ...(markup ? { reply_markup: markup } : {}),
      })
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...(markup ? { reply_markup: markup } : {}) })
    }
  } catch {
    // best-effort
  }
}
