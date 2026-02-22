import type { BotContext } from '../../types/context.js'

const HELP_TEXT = `
*ClaudeBot* \u{2014} \u{624B}\u{6A5F}\u{9059}\u{63A7} Claude Code

\u{2500}\u{2500}\u{2500} *\u{6307}\u{4EE4}* \u{2500}\u{2500}\u{2500}
/projects \u{2014} \u{700F}\u{89BD}\u{8207}\u{9078}\u{64C7}\u{5C08}\u{6848}
/select \`<\u{540D}\u{7A31}>\` \u{2014} \u{5FEB}\u{901F}\u{5207}\u{63DB}\u{5C08}\u{6848}
/model \u{2014} \u{5207}\u{63DB}\u{6A21}\u{578B} (haiku/sonnet/opus)
/status \u{2014} \u{67E5}\u{770B}\u{904B}\u{884C}\u{72C0}\u{614B}\u{8207}\u{4F47}\u{5217}
/cancel \u{2014} \u{505C}\u{6B62}\u{76EE}\u{524D}\u{904B}\u{884C}\u{4E2D}\u{7684}\u{7A0B}\u{5E8F}
/new \u{2014} \u{65B0}\u{5C0D}\u{8A71}\u{FF08}\u{6E05}\u{9664}\u{6B77}\u{53F2}\u{FF09}
/fav \u{2014} \u{66F8}\u{7C64}\u{5217}\u{8868} | \`add/rm/swap/list\`
/mkdir \`<\u{540D}\u{7A31}>\` \u{2014} \u{5EFA}\u{7ACB}\u{65B0}\u{5C08}\u{6848}\u{8CC7}\u{6599}\u{593E}
/cd \`<\u{8DEF}\u{5F91}>\` \u{2014} \u{5207}\u{63DB}\u{5DE5}\u{4F5C}\u{76EE}\u{9304}
/screenshot \u{2014} \u{622A}\u{53D6}\u{5168}\u{90E8}\u{87A2}\u{5E55}
/screenshot \`1\`\u{2013}\`9\` \u{2014} \u{622A}\u{53D6}\u{6307}\u{5B9A}\u{87A2}\u{5E55}
/screenshot \`list\` \u{2014} \u{5217}\u{51FA}\u{53EF}\u{7528}\u{87A2}\u{5E55}
/screenshot \`<URL>\` \u{2014} \u{622A}\u{53D6}\u{7DB2}\u{9801}\u{756B}\u{9762}
/todo \`<\u{5167}\u{5BB9}>\` \u{2014} \u{65B0}\u{589E}\u{5F85}\u{8FA6}\u{4E8B}\u{9805}
/todos \u{2014} \u{67E5}\u{770B}\u{76EE}\u{524D}\u{5C08}\u{6848}\u{7684}\u{5F85}\u{8FA6}
/1\u{2013}/9 \u{2014} \u{5207}\u{63DB}\u{5230}\u{66F8}\u{7C64}\u{5C08}\u{6848}
/help \u{2014} \u{986F}\u{793A}\u{6B64}\u{8AAA}\u{660E}

\u{2500}\u{2500}\u{2500} *\u{529F}\u{80FD}\u{7279}\u{8272}* \u{2500}\u{2500}\u{2500}
\u{1F4AC} *\u{5373}\u{6642}\u{4E32}\u{6D41}* \u{2014} \u{5373}\u{6642}\u{67E5}\u{770B}\u{56DE}\u{61C9}
\u{1F527} *\u{5DE5}\u{5177}\u{8FFD}\u{8E64}* \u{2014} \u{5373}\u{6642}\u{986F}\u{793A}\u{5DE5}\u{5177}\u{4F7F}\u{7528}\u{6B21}\u{6578}
\u{1F4DD} *\u{8A0A}\u{606F}\u{5408}\u{4F75}* \u{2014} \u{5FEB}\u{901F}\u{9023}\u{767C}\u{81EA}\u{52D5}\u{5408}\u{4F75} (2\u{79D2})
\u{26A1} *\u{4E26}\u{884C}\u{8655}\u{7406}* \u{2014} \u{591A}\u{5C08}\u{6848}\u{540C}\u{6642}\u{904B}\u{884C}
\u{1F504} *\u{8F49}\u{5411}\u{6A21}\u{5F0F}* \u{2014} \u{524D}\u{7DB4} \`!\` \u{53D6}\u{6D88}\u{76EE}\u{524D}\u{4E26}\u{91CD}\u{65B0}\u{63D0}\u{554F}

\u{2500}\u{2500}\u{2500} *\u{5FEB}\u{901F}\u{958B}\u{59CB}* \u{2500}\u{2500}\u{2500}
1. /projects \u{2192} \u{9078}\u{64C7}\u{5C08}\u{6848}
2. \u{8F38}\u{5165}\u{4F60}\u{7684}\u{63D0}\u{793A}
3. \u{5373}\u{6642}\u{770B} Claude \u{5DE5}\u{4F5C}
`.trim()

export async function helpCommand(ctx: BotContext): Promise<void> {
  await ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' })
}
