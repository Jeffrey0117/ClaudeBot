---
name: claudebot-claude-runner
description: Claude CLI 整合細節：spawn 參數、stream-json 解析、session 管理、prompt 建構。
---

# Claude CLI Integration

## Spawning Claude CLI

File: `src/claude/claude-runner.ts`

### CRITICAL: shell: false

```typescript
spawn(cmd, args, { cwd: projectPath, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
```

**NEVER use `shell: true`** — user prompts from Telegram become CLI arguments. Shell metacharacters (`"`, `'`, `&`, `|`, `;`, `$`) will be interpreted, causing:
- Prompt truncation (user messages get cut off)
- Command injection (security vulnerability)

### Windows Compatibility

On Windows, `claude` is a `.cmd` file that can't be spawned with `shell: false` directly. The `resolveClaudeCli()` function finds the actual `cli.js` and runs it via `node`:

```typescript
// Windows: node C:/path/to/cli.js -p "prompt" ...
// Unix: claude -p "prompt" ...
```

## CLI Arguments

```typescript
const args = [
  ...claudeCli.prefix,      // [cli.js] on Windows, [] on Unix
  '-p', fullPrompt,          // Print mode (non-interactive)
  '--output-format', 'stream-json',
  '--verbose',
  '--model', model,          // haiku | sonnet | opus
  '--dangerously-skip-permissions',
]

if (sessionId) {
  args.push('--resume', sessionId)  // Continue previous conversation
}

if (env.MAX_TURNS) {
  args.push('--max-turns', String(env.MAX_TURNS))
}
```

## Prompt Construction

The prompt is built from multiple parts:

1. **Pending todos** — auto-injected from `todo-store.ts`
2. **User prompt** — the actual message from Telegram
3. **Image paths** — if user sent images, appended with instructions to use Read tool

## Stream-JSON Parsing

Claude CLI outputs one JSON object per line on stdout:

```
{"type":"assistant","message":{"content":[...]}}
{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
{"type":"content_block_start","content_block":{"type":"tool_use","name":"Read"}}
{"type":"result","session_id":"abc","total_cost_usd":0.01,"duration_ms":5000}
```

### Event Types (defined in `src/types/claude-stream.ts`)

| Event | Purpose | Action |
|-------|---------|--------|
| `assistant` | Full message with content blocks | Extract text/tool_use |
| `content_block_delta` | Incremental text | Accumulate + onTextDelta |
| `content_block_start` | Tool use started | onToolUse(name) |
| `result` | Final result | Save sessionId + onResult |

### Parsing Flow

```
stdout chunk → buffer += chunk → split('\n') → JSON.parse each line → handleStreamEvent()
```

**stderr is NOT fatal** — Claude CLI outputs progress/warnings to stderr. Don't treat it as an error.

## Session Management

File: `src/claude/session-store.ts`

- Sessions stored in `.sessions.json` (project path → session ID)
- On successful `result` event: `setSessionId(projectPath, sessionId)`
- On `/new` command: `clearSession(projectPath)`
- On `/logout`: `clearAllSessions()`
- Session ID passed via `--resume <id>` flag

## Active Process Tracking

- `activeProcesses` Map tracks running Claude processes by project path
- `isRunning(projectPath?)` — check if a process is active
- `cancelRunning(projectPath?)` — SIGTERM the process
- `getElapsedMs(projectPath)` — how long current process has been running
