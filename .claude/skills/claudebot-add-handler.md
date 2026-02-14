---
name: claudebot-add-handler
description: 如何新增 Telegram 訊息處理器（photo、document、sticker 等非 command 類型）。
---

# Adding a New Message Handler

## When to Use

When the bot needs to handle a new Telegram message type (not a `/command`), e.g.:
- Photo messages → `bot.on('photo', handler)`
- Document messages → `bot.on('document', handler)`
- Voice messages → `bot.on('voice', handler)`
- Sticker messages → `bot.on('sticker', handler)`

## Checklist

1. **Create handler file** in `src/bot/handlers/<type>-handler.ts`
2. **Register in bot.ts** — add import + `bot.on('<type>', handler)`
3. **Update QueueItem if needed** — add new fields to `src/types/index.ts`
4. **Update queue-processor.ts if needed** — handle new fields, cleanup

## Handler Template

```typescript
// src/bot/handlers/voice-handler.ts
import type { BotContext } from '../../types/context.js'
import { getUserState } from '../state.js'
import { getSessionId } from '../../claude/session-store.js'
import { enqueue } from '../../claude/queue.js'

export async function voiceHandler(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const state = getUserState(chatId)
  if (!state.selectedProject) {
    await ctx.reply('No project selected. Use /projects to pick one first.')
    return
  }

  const message = ctx.message
  if (!message || !('voice' in message)) return

  // Process the message type...
  // Download file if needed: ctx.telegram.getFileLink(fileId)

  const project = state.selectedProject
  const sessionId = getSessionId(project.path)

  enqueue({
    chatId,
    prompt: 'your prompt here',
    project,
    model: state.model,
    sessionId,
    imagePaths: [],
  })

  await ctx.reply('⏳ Queued...')
}
```

## Registration Order in bot.ts

```typescript
// Order matters! More specific handlers first:
bot.on('callback_query', callbackHandler)  // Inline keyboards
bot.on('photo', photoHandler)              // Photos
bot.on('document', documentHandler)        // Files
bot.on('text', messageHandler)             // Text (catch-all, LAST)
```

**Important:** `bot.on('text')` is the catch-all — register it LAST or it will intercept other message types.

## File Download Pattern

```typescript
const fileLink = await ctx.telegram.getFileLink(fileId)
const response = await fetch(fileLink.href)
const buffer = Buffer.from(await response.arrayBuffer())
// Save to temp, process, cleanup after done
```

Use `src/utils/image-downloader.ts` as reference for download + cleanup pattern.
