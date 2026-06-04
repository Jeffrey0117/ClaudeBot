import type { BotContext } from '../../types/context.js'
import { env } from '../../config/env.js'
import { getPairingByLabel } from '../../remote/pairing-store.js'
import { remoteToolCall } from '../../remote/relay-client.js'

/**
 * /bootstrap <machine> — provision a paired machine with your Claude config.
 *
 * Clones (or pulls) the config repo (env.BOOTSTRAP_REPO) into the remote's
 * %USERPROFILE% and runs its install.ps1. Deterministic + cheap: two remote
 * shell steps, no AI reasoning — so setting up a new machine is one command
 * (seconds, ~free) instead of letting Claude improvise it tool-by-tool.
 *
 * Sibling of /fabric (ship a project) — this ships the dev environment/config.
 */
export async function bootstrapCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return
  const threadId = ctx.message && 'message_thread_id' in ctx.message
    ? ctx.message.message_thread_id
    : undefined

  const repo = env.BOOTSTRAP_REPO
  if (!repo) {
    await ctx.reply('❌ 未設定 BOOTSTRAP_REPO（在 .env 設定你的 Claude 設定 repo 網址）。')
    return
  }

  const machineLabel = (ctx.message && 'text' in ctx.message ? ctx.message.text ?? '' : '')
    .replace(/^\/bootstrap\s*/, '').trim().split(/\s+/)[0]
  if (!machineLabel) {
    await ctx.reply('用法: `/bootstrap <機器>`\n（在該機器 clone 設定 repo + 跑 install.ps1，`/machines` 看 label）', { parse_mode: 'Markdown' })
    return
  }

  const pairing = getPairingByLabel(chatId, threadId, machineLabel)
  if (!pairing || !pairing.connected) {
    await ctx.reply(`❌ 機器未連線: ${machineLabel}（/machines 看在線機器）`)
    return
  }

  // Repo folder name (strip .git + path)
  const name = (repo.split(/[/\\]/).pop() || 'config').replace(/\.git$/, '').replace(/[^a-zA-Z0-9_.-]/g, '_')

  // cmd.exe-native: clone or pull into %USERPROFILE%\<name>, then run install.ps1
  const cmd =
    `cd /d "%USERPROFILE%" && ` +
    `(if exist "${name}\\.git" (cd "${name}" && git pull) ` +
    `else (git clone ${repo} "${name}" && cd "${name}")) && ` +
    `powershell -ExecutionPolicy Bypass -File install.ps1`

  try {
    await ctx.reply(`🧰 ${machineLabel}: clone/pull ${name} + 套用設定中…`)
    const out = await remoteToolCall(pairing.code, 'remote_execute_command', { command: cmd }, 300_000)
    await ctx.reply(`✅ ${machineLabel} 設定環境已套用（${name}）\n\n${out.slice(0, 700)}`)
  } catch (err) {
    await ctx.reply(`⚠️ bootstrap 失敗: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`)
  }
}
