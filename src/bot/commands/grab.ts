import { Input } from 'telegraf'
import type { BotContext } from '../../types/context.js'
import { getPairing } from '../../remote/pairing-store.js'
import { remoteToolCall } from '../../remote/relay-client.js'

/**
 * Resolve a user-supplied path to an absolute path on the remote machine.
 * If the path is already absolute (e.g. C:\Users\...) it is returned as-is.
 * Otherwise we query the remote for its home directory and prepend it.
 */
async function resolveRemotePath(code: string, inputPath: string): Promise<string> {
  // Already absolute (Windows drive letter or Unix /)
  if (/^[a-zA-Z]:/.test(inputPath) || inputPath.startsWith('/')) {
    return inputPath
  }

  // Query remote home directory (works on both Windows and Unix)
  const raw = (
    await remoteToolCall(code, 'remote_execute_command', {
      command: 'node -e "console.log(require(\'os\').homedir())"',
    })
  ).trim().replace(/\r/g, '')
  // Take the last non-empty line (skip any stderr noise)
  const homeDir = raw.split('\n').filter(Boolean).pop() ?? raw

  // Combine: homeDir + relative path
  return `${homeDir}/${inputPath}`
}

export async function grabCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const threadId = ctx.message?.message_thread_id
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : ''
  const remotePath = text.replace(/^\/grab\s*/i, '').trim()

  if (!remotePath) {
    await ctx.reply(
      '用法: `/grab path/to/file`\n' +
      '從配對的遠端電腦下載檔案。\n\n' +
      '支援相對路徑（自動以遠端家目錄展開）:\n' +
      '`/grab Desktop/file.txt`\n' +
      '`/grab Downloads/report.pdf`',
      { parse_mode: 'Markdown' },
    )
    return
  }

  const pairing = getPairing(chatId, threadId)
  if (!pairing?.connected) {
    await ctx.reply('尚未配對遠端電腦，先用 /pair 建立連線。')
    return
  }

  try {
    const absolutePath = await resolveRemotePath(pairing.code, remotePath)
    const result = await remoteToolCall(pairing.code, 'remote_fetch_file', { path: absolutePath })
    const parsed = JSON.parse(result) as { name: string; size: number; base64: string }
    const buffer = Buffer.from(parsed.base64, 'base64')

    await ctx.replyWithDocument(
      Input.fromBuffer(buffer, parsed.name),
      { caption: `${parsed.name} (${formatSize(parsed.size)})` },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.reply(`❌ 下載失敗: ${msg}`)
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
