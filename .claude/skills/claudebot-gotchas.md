---
name: claudebot-gotchas
description: ClaudeBot 開發已知地雷和解法。遇到 bug 時先查這裡。
---

# Known Gotchas

## 1. shell: false (CRITICAL)

**Problem:** `spawn('claude', args, { shell: true })` causes user messages to be truncated or interpreted as shell commands.

**Fix:** Always use `shell: false`. On Windows, resolve the actual `cli.js` path instead.

**Symptom:** Telegram 使用者的訊息被截斷，尤其是包含引號、括號、`&`、`|` 等符號時。

## 2. Claude CLI stderr is NOT fatal

**Problem:** Claude CLI outputs progress info and warnings to stderr.

**Fix:** Log stderr but don't treat it as an error. Only `proc.on('close', code)` with non-zero code is a real error.

## 3. Telegram "message is not modified"

**Problem:** `editMessageText` throws when the new text is identical to current text.

**Fix:** Catch and ignore this specific error:
```typescript
telegram.editMessageText(...).catch(() => {})
```

## 4. Telegram 4096 character limit

**Problem:** Messages longer than 4096 characters fail to send.

**Fix:** Use `splitText()` from `src/utils/text-splitter.ts` to split at word/newline boundaries.

## 5. Debounce: reset pattern, not skip pattern

**Problem:** Timer-based debounce must clear previous timer before setting new one.

**Fix:**
```typescript
// CORRECT: Reset pattern
clearTimeout(timer)
timer = setTimeout(fn, delay)

// WRONG: Skip pattern
if (!timer) timer = setTimeout(fn, delay)
```

## 6. Windows: `nul` is a reserved filename

**Problem:** Can't create or git-add a file named `nul` on Windows.

**Fix:** Add to `.gitignore`.

## 7. Unicode in help.ts

**Problem:** Chinese characters in help.ts use unicode escape sequences (e.g., `\u{5C08}\u{6848}`).

**Fix:** Follow the existing pattern. Use unicode escapes to stay consistent. The Edit tool may not match raw Chinese characters against escaped versions.

## 8. Telegraf handler registration order

**Problem:** `bot.on('text')` catches almost everything.

**Fix:** Register specific handlers (`photo`, `document`) BEFORE `text` handler.

## 9. Image temp file cleanup

**Problem:** Downloaded images pile up in temp directory.

**Fix:** `queue-processor.ts` calls `cleanupImage()` in the `done()` callback, which runs on result, error, or timeout.

## 10. Multi-instance .sessions.json conflict

**Problem:** Multiple bot instances sharing the same working directory will conflict on `.sessions.json`.

**Fix:** Run each instance from a different directory, or make session file path configurable per instance.
