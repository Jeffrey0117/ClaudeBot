---
name: claudebot-add-command
description: 如何新增一個 Telegram bot 指令。固定三步驟：建立 command file → bot.ts 註冊 → help.ts 更新。
---

# Adding a New Bot Command

## Checklist (3 steps, do ALL)

1. **Create command file** in `src/bot/commands/<name>.ts`
2. **Register in bot.ts** — add import + `bot.command()`
3. **Update help.ts** — add to HELP_TEXT (use unicode escapes for Chinese)

## Step 1: Command File Template

```typescript
// src/bot/commands/example.ts
import type { BotContext } from '../../types/context.js'

export async function exampleCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  // Extract arguments after the command
  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const args = text.replace(/^\/example\s*/, '').trim()

  // Get user state if needed
  // const state = getUserState(chatId)

  await ctx.reply('Response here')
}
```

## Step 2: Register in bot.ts

```typescript
// Add import at top
import { exampleCommand } from './commands/example.js'

// Add in createBot() after other commands
bot.command('example', exampleCommand)
```

## Step 3: Update help.ts

Help text uses unicode escapes for Chinese characters. Follow existing pattern:

```typescript
/example \`<參數>\` \u{2014} \u{8aaa}\u{660e}\u{6587}\u{5b57}
```

## Conventions

- Command functions are `async` and return `Promise<void>`
- Always check `chatId` exists first
- Use `getUserState(chatId)` for project/model context
- Use `ctx.reply()` for responses, with `{ parse_mode: 'Markdown' }` if needed
- Commands that need a selected project should validate `state.selectedProject`
- Input validation with clear error messages
- File name matches command name (e.g., `/mkdir` → `mkdir.ts`)
