import type { BotContext } from '../../types/context.js'
import { getLoadedPlugins } from '../../plugins/loader.js'

const CORE_HELP = `
*ClaudeBot* \u{2014} 手機遙控 Claude Code

\u{2500}\u{2500}\u{2500} *指令* \u{2500}\u{2500}\u{2500}
/projects \u{2014} 瀏覽與選擇專案
/select \`<名稱>\` \u{2014} 快速切換專案
/model \u{2014} 切換模型 (haiku/sonnet/opus)
/status \u{2014} 查看運行狀態與佇列
/cancel \u{2014} 停止目前運行中的程序
/new \u{2014} 新對話（清除歷史）
/chat \u{2014} 通用對話模式（不需專案）
/fav \u{2014} 書籤列表 | \`add/rm/swap/list\`
/mkdir \`<名稱>\` \u{2014} 建立新專案資料夾
/cd \`<路徑>\` \u{2014} 切換工作目錄
/run \`<專案>\` \`<提示>\` \u{2014} 跨專案執行
/todo \`<內容>\` \u{2014} 新增待辦事項
/todos \u{2014} 查看目前專案的待辦
/1\u{2013}/9 \u{2014} 切換到書籤專案
/help \u{2014} 顯示此說明`.trim()

const FEATURES_HELP = `
\u{2500}\u{2500}\u{2500} *功能特色* \u{2500}\u{2500}\u{2500}
💬 *即時串流* \u{2014} 即時查看回應
🔧 *工具追蹤* \u{2014} 即時顯示工具使用次數
📝 *訊息合併* \u{2014} 快速連發自動合併 (2秒)
⚡ *並行處理* \u{2014} 多專案同時運行
🔄 *轉向模式* \u{2014} 前綴 \`!\` 取消目前並重新提問

\u{2500}\u{2500}\u{2500} *快速開始* \u{2500}\u{2500}\u{2500}
1. /projects → 選擇專案
2. 輸入你的提示
3. 即時看 Claude 工作`.trim()

export async function helpCommand(ctx: BotContext): Promise<void> {
  const plugins = getLoadedPlugins()

  let pluginSection = ''
  if (plugins.length > 0) {
    const lines = plugins.flatMap((p) =>
      p.commands.map((cmd) => `/${cmd.name} \u{2014} ${cmd.description}`)
    )
    pluginSection = `\n\n\u{2500}\u{2500}\u{2500} *插件* \u{2500}\u{2500}\u{2500}\n${lines.join('\n')}`
  }

  const text = `${CORE_HELP}${pluginSection}\n\n${FEATURES_HELP}`
  await ctx.reply(text, { parse_mode: 'Markdown' })
}
