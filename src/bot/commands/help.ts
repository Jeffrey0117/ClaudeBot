import type { BotContext } from '../../types/context.js'
import { getLoadedPlugins } from '../../plugins/loader.js'
import { splitText } from '../../utils/text-splitter.js'

const CORE_HELP = `
*ClaudeBot* \u{2014} 手機遙控 Claude Code

\u{2500}\u{2500}\u{2500} *Claude 控制* \u{2500}\u{2500}\u{2500}
/projects \u{2014} 瀏覽與選擇專案
/select \`<名稱>\` \u{2014} 快速切換專案
/1\u{2013}/9 \u{2014} 切換到書籤專案
/fav \u{2014} 書籤管理 | \`add/rm/swap/list\`
/model \u{2014} 切換 AI 後端與模型
/status \u{2014} 運行狀態與佇列
/cancel \u{2014} 停止運行 + 清空佇列
/new \u{2014} 新對話（清除 session）
/chat \u{2014} 通用對話模式（不需專案）
/deep \u{2014} 深度分析（Opus + subagent）
/parallel \u{2014} 多任務並行（worktree）
/channel \u{2014} 常駐 session 模式 | \`on/off/status\`
/ctx \u{2014} 查看/清除上下文摘要 | \`reload\`
/context \u{2014} 上下文釘選 | \`pin/list/clear\`
/last \u{2014} 重送最近訊息（/last2=上上條）
/prompt \u{2014} 查看/設定額外 system prompt
\`!\` 前綴 \u{2014} 取消目前任務並轉向新提問

\u{2500}\u{2500}\u{2500} *檔案與專案* \u{2500}\u{2500}\u{2500}
/run \`<專案> <提示>\` \u{2014} 跨專案一次性執行
/mkdir \`<名稱>\` \u{2014} 建立新專案資料夾
/cd \`<路徑>\` \u{2014} 切換工作目錄
/sync \u{2014} 同步所有 worktree
/land \u{2014} 把 bot 改動併回 master
/claudemd \u{2014} 生成/更新 CLAUDE.md
/todo /todos \u{2014} 待辦管理
/idea /ideas \u{2014} 靈感記錄（#tag）

\u{2500}\u{2500}\u{2500} *部署 CloudPipe* \u{2500}\u{2500}\u{2500}
/deploy \u{2014} commit + push + 部署追蹤
直接打「部署 xxx」「重啟 xxx」「xxx log」「全部還好嗎」也通（零 AI 額度）`.trim()

const REMOTE_HELP = `
\u{2500}\u{2500}\u{2500} *遠端機器* \u{2500}\u{2500}\u{2500}
/pair \`code@ip:port\` \u{2014} 配對遠端電腦
/machines \u{2014} 機器列表/切換 · /unpair 斷開 · /rpair 重啟 agent
/ron \u{2014} 開 app/GUI · /rx \u{2014} 跑指令
/ropen \u{2014} 開網址 · /rkill \u{2014} 殺程式
/rpower \u{2014} lock/sleep/reboot/shutdown
/rpull \u{2014} git pull · /rclip \u{2014} 剪貼簿
/rls /rshot /rstat /rstatus /rlog \u{2014} 檔案/截圖/狀態/log
/rnotify \u{2014} 桌面通知 · /grab \u{2014} 下載檔案
/js \u{2014} 在遠端 Chrome 跑 JS（CDP）
/selfupdate \u{2014} 遠端自我更新
/fabric \u{2014} 打包專案投遞過去跑
/bootstrap \u{2014} 遠端裝環境

\u{2500}\u{2500}\u{2500} *網頁 / IG* \u{2500}\u{2500}\u{2500}
/bv \u{2014} 網頁視覺 agent（Playwright + Gemini）
/sniff \u{2014} 抓網頁背後的 JSON API
/us \u{2014} 跑油猴腳本（注入+下載）
/ig \u{2014} IG 發文/Reel 自動化
/igdl \u{2014} 下載 IG 貼文/Reel（貼連結即可）

\u{2500}\u{2500}\u{2500} *Bot 管理* \u{2500}\u{2500}\u{2500}
/restart \u{2014} 重啟 Bot（all=全部）
/newbot \u{2014} 建立新 bot 實例
/store /install /uninstall /reload \u{2014} 插件管理
/asr \u{2014} 語音轉文字 on/off
/license \u{2014} 桌面版授權（admin）`.trim()

const FEATURES_HELP = `
\u{2500}\u{2500}\u{2500} *隨手技* \u{2500}\u{2500}\u{2500}
💬 即時串流回應 · 📝 連發訊息自動合併
🎙 語音訊息直接轉文字進 Claude
🔄 \`!\` 轉向 · ⚡ 多專案並行 · 📎 [CTX] 記憶

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

  const text = `${CORE_HELP}\n\n${REMOTE_HELP}${pluginSection}\n\n${FEATURES_HELP}\n\n📖 完整文檔：jeffrey0117.github.io/ClaudeBot`

  // Full command list + plugins can exceed Telegram's 4096 cap — split safely.
  for (const chunk of splitText(text)) {
    try {
      await ctx.reply(chunk, { parse_mode: 'Markdown' })
    } catch {
      await ctx.reply(chunk).catch(() => {})
    }
  }
}
