# Screenshot Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users capture web screenshots from Telegram and auto-detect images in Claude CLI responses.

**Architecture:** Two features: (1) `/screenshot <URL>` command uses Playwright headless browser to capture and send back screenshots; (2) queue-processor scans Claude result text for image file paths and sends them as photos via Telegram.

**Tech Stack:** Playwright (chromium), Telegraf `sendPhoto`, Node.js `fs.existsSync`

---

### Task 1: Install Playwright dependency

**Files:**
- Modify: `package.json:14-19`

**Step 1: Install playwright**

Run: `npm install playwright`

**Step 2: Install chromium browser**

Run: `npx playwright install chromium`

**Step 3: Verify installation**

Run: `node -e "const { chromium } = require('playwright'); console.log('OK')"`
Expected: `OK`

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add playwright dependency for screenshot feature"
```

---

### Task 2: Create image-detector utility

**Files:**
- Create: `src/utils/image-detector.ts`
- Create: `tests/utils/image-detector.test.ts`

**Step 1: Write the failing test**

Create `tests/utils/image-detector.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { detectImagePaths } from '../../src/utils/image-detector.js'

describe('detectImagePaths', () => {
  it('detects absolute Windows paths with image extensions', () => {
    const text = 'Screenshot saved to C:\\Users\\jeff\\app\\screenshot.png'
    const paths = detectImagePaths(text)
    expect(paths).toEqual(['C:\\Users\\jeff\\app\\screenshot.png'])
  })

  it('detects forward-slash paths', () => {
    const text = 'Image at /home/user/output/result.jpg done'
    const paths = detectImagePaths(text)
    expect(paths).toEqual(['/home/user/output/result.jpg'])
  })

  it('detects multiple image paths', () => {
    const text = 'Files: C:\\a\\one.png and C:\\b\\two.jpeg'
    const paths = detectImagePaths(text)
    expect(paths).toEqual(['C:\\a\\one.png', 'C:\\b\\two.jpeg'])
  })

  it('supports all image extensions', () => {
    const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp']
    for (const ext of extensions) {
      const text = `C:\\img\\file.${ext}`
      expect(detectImagePaths(text).length).toBe(1)
    }
  })

  it('returns empty array when no images found', () => {
    const text = 'No images here, just some text about coding.'
    expect(detectImagePaths(text)).toEqual([])
  })

  it('ignores non-image file extensions', () => {
    const text = 'File at C:\\app\\data.json and C:\\app\\index.ts'
    expect(detectImagePaths(text)).toEqual([])
  })

  it('deduplicates paths', () => {
    const text = 'C:\\a\\img.png and again C:\\a\\img.png'
    expect(detectImagePaths(text)).toEqual(['C:\\a\\img.png'])
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/utils/image-detector.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/utils/image-detector.ts`:

```typescript
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

const EXTENSIONS_PATTERN = IMAGE_EXTENSIONS.join('|')

// Match absolute paths: C:\...\file.png or /home/.../file.png
const PATH_REGEX = new RegExp(
  `(?:[A-Za-z]:\\\\[^\\s"'<>|*?]+|/[^\\s"'<>|*?]+)\\.(?:${EXTENSIONS_PATTERN})`,
  'gi'
)

export function detectImagePaths(text: string): readonly string[] {
  const matches = text.match(PATH_REGEX)
  if (!matches) return []
  return [...new Set(matches)]
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/utils/image-detector.test.ts`
Expected: PASS — all 7 tests green

**Step 5: Commit**

```bash
git add src/utils/image-detector.ts tests/utils/image-detector.test.ts
git commit -m "feat: add image path detection utility with tests"
```

---

### Task 3: Create `/screenshot` command

**Files:**
- Create: `src/bot/commands/screenshot.ts`

**Step 1: Write the screenshot command**

Create `src/bot/commands/screenshot.ts`:

```typescript
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import type { BotContext } from '../../types/context.js'
import { InputFile } from 'telegraf'

const TEMP_DIR = join(tmpdir(), 'claudebot-screenshots')
const VIEWPORT = { width: 1280, height: 720 }
const TIMEOUT_MS = 30_000

async function ensureTempDir(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true })
}

export async function screenshotCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const args = raw.replace(/^\/screenshot\s*/, '').trim().split(/\s+/)
  const url = args[0]
  const fullPage = args[1]?.toLowerCase() === 'full'

  if (!url) {
    await ctx.reply(
      '用法: `/screenshot <URL> [full]`\n\n例如:\n`/screenshot http://localhost:3000`\n`/screenshot https://example.com full`',
      { parse_mode: 'Markdown' }
    )
    return
  }

  // Basic URL validation
  try {
    new URL(url)
  } catch {
    await ctx.reply('❌ 無效的 URL。')
    return
  }

  const statusMsg = await ctx.reply('📸 截圖中...')

  await ensureTempDir()
  const filePath = join(TEMP_DIR, `${randomUUID()}.png`)

  let browser
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT_MS })
    await page.screenshot({ path: filePath, fullPage })

    await ctx.replyWithPhoto(new InputFile(filePath), {
      caption: `📸 ${url}${fullPage ? ' (全頁)' : ''}`,
    })

    await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.telegram.editMessageText(
      chatId, statusMsg.message_id, undefined,
      `❌ 截圖失敗: ${msg}`
    ).catch(() => {})
  } finally {
    await browser?.close()
    await unlink(filePath).catch(() => {})
  }
}
```

**Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bot/commands/screenshot.ts
git commit -m "feat: add /screenshot command with Playwright"
```

---

### Task 4: Register `/screenshot` in bot and help text

**Files:**
- Modify: `src/bot/bot.ts:22-23` (add import)
- Modify: `src/bot/bot.ts:54` (add command registration)
- Modify: `src/bot/commands/help.ts:15` (add help entry)

**Step 1: Add import to bot.ts**

In `src/bot/bot.ts`, after line 22 (`import { cdCommand }`), add:

```typescript
import { screenshotCommand } from './commands/screenshot.js'
```

**Step 2: Register command in bot.ts**

In `src/bot/bot.ts`, after `bot.command('cd', cdCommand)` (line 53), add:

```typescript
  bot.command('screenshot', screenshotCommand)
```

**Step 3: Add help text in help.ts**

In `src/bot/commands/help.ts`, after the `/cd` line (line 15), add:

```
/screenshot \`<URL>\` — 截取網頁畫面
```

(Use unicode escapes matching existing file style.)

**Step 4: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bot/bot.ts src/bot/commands/help.ts
git commit -m "feat: register /screenshot command and add help text"
```

---

### Task 5: Add image auto-detection to queue-processor

**Files:**
- Modify: `src/bot/queue-processor.ts:6-7` (add imports)
- Modify: `src/bot/queue-processor.ts:96-131` (modify onResult handler)

**Step 1: Add imports to queue-processor.ts**

At the top of `src/bot/queue-processor.ts`, after the existing imports (line 7), add:

```typescript
import { existsSync } from 'node:fs'
import { InputFile } from 'telegraf'
import { detectImagePaths } from '../utils/image-detector.js'
```

**Step 2: Modify onResult handler**

In the `onResult` callback (starting at line 96), after the status update block (line 111) and before sending the response text (line 113), add image detection and sending logic:

```typescript
            // Detect and send any image files mentioned in the response
            const responseText = result.resultText || accumulated || ''
            const imagePaths = detectImagePaths(responseText)
            const validImages = imagePaths.filter((p) => existsSync(p))

            let imageChain = Promise.resolve()
            for (const imgPath of validImages) {
              imageChain = imageChain.then(() =>
                telegram.sendPhoto(item.chatId, new InputFile(imgPath), {
                  caption: imgPath,
                }).then(() => {})
              ).catch((err) => {
                console.error('[queue] sendPhoto error:', err)
              })
            }

            // After images, send text response
            imageChain.then(() => {
              if (!responseText) {
                done()
                return
              }

              const chunks = splitText(responseText, 4096)
              let chain = Promise.resolve()
              for (const chunk of chunks) {
                chain = chain.then(() =>
                  telegram.sendMessage(item.chatId, chunk).then(() => {})
                )
              }
              chain.then(() => done()).catch(() => done())
            }).catch(() => done())
```

This replaces the existing text-sending block (lines 113-127).

**Step 3: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Manual test**

1. Start bot: `npm run dev`
2. Send a message to Claude asking it to create a screenshot
3. Verify the image comes back in Telegram

**Step 5: Commit**

```bash
git add src/bot/queue-processor.ts
git commit -m "feat: auto-detect and send image files from Claude responses"
```

---

### Task 6: Final verification and push

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Push**

```bash
git push
```
