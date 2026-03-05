# ClaudeBot

Telegram bot → Claude Code CLI → mobile command center.
Platform with plugins, queue, multi-project, multi-AI, and interactive UI.

## Stack
- Node.js + TypeScript (strict), Telegraf v4, zod, bcrypt
- Entry: `src/launcher.ts` → spawns 1–N bot instances from `.env`, `.env.bot2`, etc.

## Directory structure

```
src/
  launcher.ts     ← Multi-bot launcher
  bot/            ← Core: commands, handlers, queue, data stores (see bot/CLAUDE.md)
  claude/         ← Claude CLI runner + session store + file lock
  ai/             ← Multi-backend AI (Claude, Gemini) + session store + router
  plugins/        ← Plugin system, hot-reloadable (see plugins/CLAUDE.md)
  remote/         ← Remote pairing via WebSocket + MCP (see remote/CLAUDE.md)
  git/            ← Git worktree management (multi-bot parallel dev)
  asr/            ← Sherpa-ONNX voice recognition
  config/         ← env, projects scanner
  utils/          ← Directives, choice detector, pipe executor
  dashboard/      ← Web dashboard (heartbeat, runner tracker)
  mcp/            ← MCP server integration
  types/          ← Shared TypeScript types
```

## Key concepts (details in subdirectory CLAUDE.md files)

- **Queue + Session**: One CLI process per bot. `--resume` keeps context. Session keyed by `${BOT_ID}:${projectPath}`
- **AI Directives**: `@cmd` `@file` `@confirm` `@notify` `@pipe` `@run` — see `src/bot/CLAUDE.md`
- **4-Layer Memory**: Bookmarks, Context Pins, AI Memory, Vault — see `src/bot/CLAUDE.md`
- **Multi-bot + Worktree**: `WORKTREE_BRANCH=bot1` → git worktree isolation per bot instance
- **Voice**: OGG → ffmpeg → Sherpa ASR → biaodian → optional Gemini refinement
- **Stream**: `stream-json` parsed line-by-line. New `assistant` event resets accumulated (prevents thinking leak)
- **Draft streaming**: Real-time message edits via `draft-sender.ts` (300ms throttle, strips [CTX] blocks)
- **/deep mode**: Opus model + 2x MAX_TURNS + subagent analysis (`data/subagent-spec.md`)
- **/ctx command**: View/clear stored digest, `/ctx reload` hot-reloads ctx-spec + subagent-spec
- **/parallel**: Concurrent worktree execution with parallel Claude CLI processes
- **Launcher**: `notifyAdmin()` to ADMIN_CHAT_ID on all events; kill with `taskkill //F //T //PID`

## Coding rules

- **Immutability**: Always create new objects, never mutate
- **Files**: Small and focused (<800 lines), organized by feature
- **Functions**: <50 lines, clear names
- **Errors**: Always handle with try/catch, user-friendly messages
- **Security**: `shell: false` on spawn, validate all user input with zod
- **No console.log** (use console.error for actual errors only)
