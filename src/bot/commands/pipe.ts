import type { BotContext } from '../../types/context.js'
import { callCloudPipeTool, listCloudPipeTools } from '../../utils/cloudpipe.js'

/**
 * /pipe — 手動呼叫 CloudPipe tools
 *
 * 用法:
 *   /pipe                     — 列出所有可用工具
 *   /pipe <tool>              — 呼叫工具（無參數）
 *   /pipe <tool> param=value  — 呼叫工具（帶參數）
 *
 * 範例:
 *   /pipe repic_remove_background url=https://...
 *   /pipe gemini.generateText prompt="寫個笑話"
 */
export async function pipeCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const args = ctx.message?.text?.split(/\s+/).slice(1) || []

  // 無參數 → 列出所有工具
  if (args.length === 0) {
    try {
      const tools = await listCloudPipeTools()

      if (tools.length === 0) {
        await ctx.reply('❌ CloudPipe 未設定或無可用工具')
        return
      }

      const list = tools
        .map(t => `  • \`${t.name}\` — ${t.description}`)
        .join('\n')

      await ctx.reply(
        `🔧 *CloudPipe Tools* (${tools.length})\n\n${list}`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }

  // 有參數 → 呼叫工具
  const tool = args[0]
  const paramPairs = args.slice(1)

  // Parse params: key=value format
  const params: Record<string, unknown> = {}
  for (const pair of paramPairs) {
    const [key, ...valueParts] = pair.split('=')
    if (!key || valueParts.length === 0) continue

    const value = valueParts.join('=') // Handle = in value

    // Try to parse as JSON if it looks like JSON
    try {
      if (value.startsWith('{') || value.startsWith('[') || value === 'true' || value === 'false' || !isNaN(Number(value))) {
        params[key] = JSON.parse(value)
      } else {
        params[key] = value
      }
    } catch {
      params[key] = value
    }
  }

  const msg = await ctx.reply(`⏳ 呼叫 \`${tool}\`...`, { parse_mode: 'Markdown' })

  try {
    const result = await callCloudPipeTool(tool, params, { useCache: false })

    if (!result.ok) {
      await ctx.telegram.editMessageText(
        chatId,
        msg.message_id,
        undefined,
        `❌ 工具呼叫失敗\n\n\`${result.error}\``,
        { parse_mode: 'Markdown' }
      )
      return
    }

    // Format result
    let output = `✅ \`${tool}\` 執行成功\n\n`

    if (typeof result.data === 'string') {
      output += result.data
    } else if (result.data) {
      output += `\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``
    } else {
      output += '(無回傳資料)'
    }

    // Telegram message length limit
    if (output.length > 4000) {
      output = output.slice(0, 3900) + '\n\n...(已截斷)'
    }

    await ctx.telegram.editMessageText(
      chatId,
      msg.message_id,
      undefined,
      output,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    await ctx.telegram.editMessageText(
      chatId,
      msg.message_id,
      undefined,
      `❌ 執行失敗: ${err instanceof Error ? err.message : String(err)}`,
      { parse_mode: 'Markdown' }
    )
  }
}
