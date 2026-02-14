---
name: claudebot-architecture
description: ClaudeBot 專案架構總覽。了解訊息流、queue 機制、session 管理、檔案結構。
---

# ClaudeBot Architecture

## Stack
Telegraf v4 + TypeScript + bcrypt + zod + dotenv

## Message Flow

```
Telegram User
    ↓
[Telegraf Bot] (polling mode)
    ↓
[Middleware] errorHandler → dedup → rateLimit → auth
    ↓
[Handler] text | photo | document | callback_query | command
    ↓
[Queue] enqueue() → FIFO, one-at-a-time per project
    ↓
[Claude Runner] spawn('claude', [...args], { shell: false })
    ↓
[Stream Parser] stdout line-by-line → JSON.parse → StreamEvent
    ↓
[Telegram Response] debounced edit → final split messages
```

## Directory Structure

```
src/
├── index.ts                    # Entry point, bot.launch()
├── bot/
│   ├── bot.ts                  # createBot() - middleware + handler registration
│   ├── state.ts                # Per-chat UserState (project, model)
│   ├── queue-processor.ts      # Queue item → runClaude() → Telegram response
│   ├── todo-store.ts           # Per-project todo persistence (data/todos.json)
│   ├── commands/               # /start, /login, /projects, /model, /cancel, /new, /fav, /todo, /mkdir, etc.
│   ├── handlers/               # message-handler, callback-handler, photo-handler
│   └── middleware/             # auth, error-handler, rate-limit, dedup
├── claude/
│   ├── claude-runner.ts        # spawn Claude CLI, parse stream-json
│   ├── queue.ts                # FIFO queue, one process at a time
│   └── session-store.ts        # Persist session IDs to .sessions.json
├── auth/
│   └── auth-service.ts         # login/logout, bcrypt or plain password
├── config/
│   ├── env.ts                  # Zod-validated env vars, --env flag support
│   └── projects.ts             # scanProjects() from PROJECTS_BASE_DIR
├── telegram/
│   └── keyboard-builder.ts     # Inline keyboard builders
├── types/
│   ├── index.ts                # ClaudeModel, ProjectInfo, QueueItem, ClaudeResult
│   ├── context.ts              # BotContext extends Telegraf Context
│   └── claude-stream.ts        # Stream event type definitions
└── utils/
    ├── text-splitter.ts        # splitText() for 4096 char limit
    ├── path-validator.ts       # Path traversal prevention
    └── image-downloader.ts     # Download Telegram images to temp dir
```

## Key Design Decisions

1. **One Claude process at a time** — queue system prevents resource exhaustion
2. **shell: false** — CRITICAL for security, prevents command injection
3. **Session continuity** — `--resume <session_id>` flag, persisted in .sessions.json
4. **stream-json output** — line-by-line parsing from stdout
5. **Debounced Telegram edits** — 1s debounce, tail truncation at 4096 chars
6. **Per-chat state** — each chatId has independent project/model selection
7. **Multi-instance** — `--env` flag to specify different .env files
8. **Auto todo injection** — pending todos are prepended to Claude prompts

## Environment Variables (in .env)

| Variable | Required | Description |
|----------|----------|-------------|
| BOT_TOKEN | Yes | Telegram bot token |
| ALLOWED_CHAT_IDS | Yes | Comma-separated chat IDs |
| PROJECTS_BASE_DIR | Yes | Base directory for projects |
| LOGIN_PASSWORD | * | Plain text password |
| LOGIN_PASSWORD_HASH | * | bcrypt hash |
| DEFAULT_MODEL | No | haiku/sonnet/opus (default: sonnet) |
| AUTO_AUTH | No | Auto-authenticate allowed chats (default: true) |
| RATE_LIMIT_MAX | No | Messages per window (default: 10) |
| RATE_LIMIT_WINDOW_MS | No | Rate limit window (default: 60000) |
| MAX_TURNS | No | Max Claude turns per request |
