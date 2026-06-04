import type { BotContext } from '../../types/context.js'
import { getPairingByLabel } from '../../remote/pairing-store.js'
import { remoteToolCall } from '../../remote/relay-client.js'

/**
 * Remote-ops command pool: thin, deterministic wrappers around the remote_*
 * agent tools — instant + zero AI cost (no opus reasoning), exposed so natural
 * language can map to them via @cmd. Sibling family of /fabric + /bootstrap.
 */

interface Resolved {
  readonly code: string
  readonly label: string
  readonly rest: string
}

/** Parse "<machine> <rest...>" from the command text and resolve the pairing. */
function resolve(ctx: BotContext, cmdName: string): Resolved | { error: string } {
  const chatId = ctx.chat?.id
  if (!chatId) return { error: 'no chat' }
  const threadId = ctx.message && 'message_thread_id' in ctx.message ? ctx.message.message_thread_id : undefined

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const args = raw.replace(new RegExp(`^/${cmdName}\\s*`), '').trim()
  const sp = args.indexOf(' ')
  const label = sp === -1 ? args : args.slice(0, sp)
  const rest = sp === -1 ? '' : args.slice(sp + 1).trim()

  if (!label) return { error: `用法: \`/${cmdName} <機器> ...\`（\`/machines\` 看 label）` }

  const pairing = getPairingByLabel(chatId, threadId, label)
  if (!pairing || !pairing.connected) return { error: `❌ 機器未連線: ${label}` }
  return { code: pairing.code, label, rest }
}

/** /ron <machine> <app> [args] — open a GUI app on the remote (visible, instant). */
export async function ronCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'ron')
  if ('error' in r) { await ctx.reply(r.error); return }
  if (!r.rest) { await ctx.reply('用法: `/ron <機器> <app>`\n例: `/ron laptop mspaint`', { parse_mode: 'Markdown' }); return }

  const parts = r.rest.split(/\s+/)
  const command = parts[0]
  const args = parts.slice(1)
  try {
    await remoteToolCall(r.code, 'remote_spawn_detached', { command, args: JSON.stringify(args) }, 20_000)
    await ctx.reply(`🚀 ${r.label}: 已開啟 ${command}（視窗應出現在該機器桌面）`)
  } catch (err) {
    await ctx.reply(`⚠️ 開啟失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /rx <machine> <cmd> — run a command on the remote and return its output. */
export async function rxCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'rx')
  if ('error' in r) { await ctx.reply(r.error); return }
  if (!r.rest) { await ctx.reply('用法: `/rx <機器> <指令>`\n例: `/rx laptop dir`', { parse_mode: 'Markdown' }); return }
  try {
    const out = await remoteToolCall(r.code, 'remote_execute_command', { command: r.rest }, 120_000)
    await ctx.reply(`💻 ${r.label} > ${r.rest}\n\n${out.slice(0, 3500) || '(無輸出)'}`)
  } catch (err) {
    await ctx.reply(`⚠️ 執行失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /rstat <machine> — remote system info (disk / memory / network). */
export async function rstatCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'rstat')
  if ('error' in r) { await ctx.reply(r.error); return }
  try {
    const out = await remoteToolCall(r.code, 'remote_system_info', {}, 30_000)
    await ctx.reply(`📊 ${r.label}\n\n${out.slice(0, 3500)}`)
  } catch (err) {
    await ctx.reply(`⚠️ 取得狀態失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** /ropen <machine> <url> — open a URL in the remote's default browser. */
export async function ropenCommand(ctx: BotContext): Promise<void> {
  const r = resolve(ctx, 'ropen')
  if ('error' in r) { await ctx.reply(r.error); return }
  if (!r.rest) { await ctx.reply('用法: `/ropen <機器> <url>`', { parse_mode: 'Markdown' }); return }
  const url = r.rest.split(/\s+/)[0]
  try {
    // `start "" "<url>"` returns immediately (no timeout hang) and opens visibly.
    await remoteToolCall(r.code, 'remote_execute_command', { command: `start "" "${url}"` }, 20_000)
    await ctx.reply(`🌐 ${r.label}: 已開啟 ${url}`)
  } catch (err) {
    await ctx.reply(`⚠️ 開啟失敗: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}
