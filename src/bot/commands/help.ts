import type { BotContext } from '../../types/context.js'

const HELP_TEXT = `
*ClaudeBot* \u{2014} Remote Claude Code CLI

\u{2500}\u{2500}\u{2500} *Commands* \u{2500}\u{2500}\u{2500}
/projects \u{2014} Browse & select project
/select \`<name>\` \u{2014} Quick switch project
/model \u{2014} Switch model (haiku/sonnet/opus)
/status \u{2014} Active projects & queue
/cancel \u{2014} Stop current project's process
/new \u{2014} Fresh session (clear history)
/fav \u{2014} Manage project bookmarks
/todo \`<text>\` \u{2014} Add a quick todo
/todos \u{2014} List todos for current project
/1\u{2013}/9 \u{2014} Switch to bookmarked project
/help \u{2014} This message

\u{2500}\u{2500}\u{2500} *Smart Features* \u{2500}\u{2500}\u{2500}
\u{1F4AC} *Live Streaming* \u{2014} See responses in real-time
\u{1F527} *Tool Tracking* \u{2014} Tool count shown inline
\u{1F4DD} *Message Batching* \u{2014} Rapid messages merged (2s window)
\u{26A1} *Parallel Processing* \u{2014} Multiple projects run simultaneously
\u{1F504} *Steer Mode* \u{2014} Prefix with \`!\` to cancel & redirect

\u{2500}\u{2500}\u{2500} *Quick Start* \u{2500}\u{2500}\u{2500}
1. /projects \u{2192} pick a project
2. Type your prompt
3. Watch Claude work in real-time
`.trim()

export async function helpCommand(ctx: BotContext): Promise<void> {
  await ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' })
}
