import type { BotContext } from '../../types/context.js'
import { getContext, clearContext } from '../context-digest-store.js'
import { reloadAllSpecs } from '../../utils/system-prompt.js'
import { getUserState } from '../state.js'
import { getPairing } from '../../remote/pairing-store.js'
import { env } from '../../config/env.js'

export async function ctxCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : ''
  const args = text.replace(/^\/ctx\s*/i, '').trim().toLowerCase()

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)

  const pairing = env.REMOTE_ENABLED ? getPairing(chatId, threadId) : null
  const project = pairing?.connected
    ? { name: 'remote', path: process.cwd() }
    : state.selectedProject

  // /ctx reload — hot-reload all spec files
  if (args === 'reload') {
    reloadAllSpecs()
    await ctx.reply('All specs reloaded (`ctx-spec.md` + `subagent-spec.md`)', { parse_mode: 'Markdown' })
    return
  }

  if (!project) {
    await ctx.reply('請先用 /projects 選擇專案')
    return
  }

  // /ctx clear — clear stored digest
  if (args === 'clear') {
    clearContext(project.path)
    await ctx.reply(`*[${project.name}]* Context digest cleared`, { parse_mode: 'Markdown' })
    return
  }

  // /ctx — show current stored digest
  const stored = getContext(project.path)
  if (!stored) {
    await ctx.reply(`*[${project.name}]* No context digest stored`, { parse_mode: 'Markdown' })
    return
  }

  if (stored.digest) {
    const d = stored.digest
    const lines = [
      `*[${project.name}] Context Digest*`,
      '',
      `*Status:* \`${d.status}\``,
      `*Summary:* ${d.summary}`,
      `*Pending:* ${d.pending}`,
      `*Next:* ${d.next}`,
    ]

    if (d.files.length > 0) {
      lines.push(`*Files:* ${d.files.map((f) => `\`${f}\``).join(', ')}`)
    }

    lines.push('', '_Use /ctx clear to reset_')
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
  } else {
    const tail = stored.rawTail.length > 200
      ? stored.rawTail.slice(0, 200) + '...'
      : stored.rawTail
    await ctx.reply(
      `*[${project.name}]* No structured digest\n\n_Raw tail (${stored.rawTail.length} chars):_\n${tail}\n\n_Use /ctx clear to reset_`,
      { parse_mode: 'Markdown' },
    )
  }
}
