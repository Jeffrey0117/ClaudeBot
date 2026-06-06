import type { BotContext } from '../../types/context.js'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { findProject } from '../../config/projects.js'
import { getPairingByLabel } from '../../remote/pairing-store.js'
import { remoteToolCall } from '../../remote/relay-client.js'
import { loadPokkitConfig, uploadToPokkit } from '../../utils/upload-executor.js'

/**
 * /fabric <project> <machine> [startCmd] — dev-fabric Slice 1.
 *
 * A packages a LOCAL project (its own GitHub/auth never leaves A), uploads the
 * tarball to pokkit, and a paired machine pulls it, extracts, `npm install`s,
 * and optionally runs it. Proves the "A 備料 → 投遞 → B 跑" pipe; credentials
 * stay on A, the project travels as an artifact. (Caching layers come later.)
 *
 * B-side is cmd.exe-native (curl + tar are built into Win10+), so no shell
 * gymnastics. Assumes B is Windows with Node on PATH.
 */
export async function fabricCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return
  const threadId = ctx.message && 'message_thread_id' in ctx.message
    ? ctx.message.message_thread_id
    : undefined

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const parts = raw.replace(/^\/fabric\s*/, '').trim().split(/\s+/)
  const projectName = parts[0]
  const machineLabel = parts[1]
  const startCmd = parts.slice(2).join(' ').trim()

  if (!projectName || !machineLabel) {
    await ctx.reply(
      '用法: `/fabric <專案> <機器> [啟動指令]`\n\n' +
      '例: `/fabric mybot laptop npm start`\n' +
      '(A 打包專案 → pokkit → 機器下載 + npm install + 跑)',
      { parse_mode: 'Markdown' },
    )
    return
  }

  const project = findProject(projectName)
  if (!project) { await ctx.reply(`❌ 找不到專案: ${projectName}`); return }

  const pairing = getPairingByLabel(chatId, threadId, machineLabel)
  if (!pairing || !pairing.connected) {
    await ctx.reply(`❌ 機器未連線: ${machineLabel}（用 /machines 看在線機器）`)
    return
  }

  const tarPath = join(tmpdir(), `fabric-${randomUUID()}.tgz`)
  try {
    // 1. Package — exclude .git / node_modules (B reinstalls deps for its platform)
    await ctx.reply(`📦 打包 ${project.name}…`)
    execFileSync('tar', [
      '-czf', tarPath, '-C', project.path,
      '--exclude=.git', '--exclude=node_modules', '.',
    ], { windowsHide: true, timeout: 120_000 })

    // 2. Upload to pokkit → download URL (1d expiry — transfer artifact only)
    await ctx.reply('☁️ 上傳 pokkit…')
    if (!loadPokkitConfig()) { await ctx.reply('❌ 未設定 pokkit（.env 加 POKKIT_API_KEY）'); return }
    const url = await uploadToPokkit(tarPath, { expiresIn: '1d' })

    // 3. B: download + extract + install (cmd.exe-native)
    await ctx.reply(`📥 ${machineLabel} 下載 + 安裝中…`)
    const dir = project.name.replace(/[^a-zA-Z0-9_.-]/g, '_')
    const dl =
      `if not exist "${dir}" mkdir "${dir}" && ` +
      `curl -L -o "${dir}\\_fab.tgz" "${url}" && ` +
      `tar -xzf "${dir}\\_fab.tgz" -C "${dir}" && ` +
      `del "${dir}\\_fab.tgz" && ` +
      `cd "${dir}" && (if exist package.json npm install)`
    const out = await remoteToolCall(pairing.code, 'remote_execute_command', { command: dl }, 300_000)

    // 4. Optional start (best-effort, detached via cmd start)
    let startNote = ''
    if (startCmd) {
      const run = `cd "${dir}" && start "" /b cmd /c "${startCmd}"`
      await remoteToolCall(pairing.code, 'remote_execute_command', { command: run }, 30_000).catch(() => {})
      startNote = `\n🚀 已嘗試啟動: ${startCmd}`
    }

    await ctx.reply(
      `✅ ${project.name} → ${machineLabel} 投遞完成\n` +
      `📂 目錄: ${dir}（在該機器 agent 工作目錄下）${startNote}\n\n` +
      `輸出:\n${out.slice(0, 600)}`,
    )
  } catch (err) {
    await ctx.reply(`⚠️ fabric 失敗: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`)
  } finally {
    try { unlinkSync(tarPath) } catch { /* ignore */ }
  }
}
