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
  jarvis/         ← Voice UI: red-dot page (:3106), speech in/out via admin-chat session
  mcp/            ← MCP server integration
  types/          ← Shared TypeScript types
```

## Key concepts (details in subdirectory CLAUDE.md files)

- **Queue + Session**: One CLI process per bot. `--resume` keeps context. Session keyed by `${BOT_ID}:${projectPath}`
- **AI Directives**: `@cmd` `@file` `@confirm` `@notify` `@pipe` `@run` — see `src/bot/CLAUDE.md`
- **4-Layer Memory**: Bookmarks, Context Pins, AI Memory, Vault — see `src/bot/CLAUDE.md`
- **Multi-bot + Worktree**: `WORKTREE_BRANCH=bot1` → git worktree isolation per bot instance
- **Voice**: OGG → ffmpeg → Sherpa ASR → biaodian → optional Gemini refinement
- **Jarvis (`src/jarvis/`)**: Fullscreen red-dot web page — browser STT (`webkitSpeechRecognition`) → enqueued as ADMIN_CHAT_ID message (shared Telegram session, voice-persona hint) → response via response-broker (`jarvis-` commandId) → browser TTS. Needs `JARVIS_TOKEN`; port `JARVIS_PORT` (3106)
- **Stream**: `stream-json` parsed line-by-line. New `assistant` event resets accumulated (prevents thinking leak)
- **Draft streaming**: Real-time message edits via `draft-sender.ts` (300ms throttle, strips [CTX] blocks)
- **/deep mode**: Opus model + 2x MAX_TURNS + subagent analysis (`data/subagent-spec.md`)
- **/ctx command**: View/clear stored digest, `/ctx reload` hot-reloads ctx-spec + subagent-spec
- **/parallel**: Concurrent worktree execution with parallel Claude CLI processes
- **/bv (Browser Vision)**: Playwright + Gemini vision web agent — turns any website into an API. Stealth mode (anti-webdriver, fake plugins/fingerprint, human-like mouse). Best for sites without heavy anti-bot; CAPTCHA-protected sites (Shopee, Cloudflare) may fail.
- **/chain**: Plugin — chain multiple steps (bv, pipe, notify, wait, cmd) into automated workflows. Variable interpolation `{{prev}}` / `{{step.N}}`. Daily scheduling via `HH:MM`. See `plugins/CLAUDE.md`.
- **Remote-only users**: `REMOTE_CHAT_IDS` env var → users can only access bot through remote pairing
- **Allot plugin**: Remote quota management — rate limit (5min window) + weekly budget, shared across all bots via `mainRepoPath()`, admin-only
- **Launcher**: `notifyAdmin()` to ADMIN_CHAT_ID on all events; kill with `taskkill //F //T //PID`

## Coding rules

- **Immutability**: Always create new objects, never mutate
- **Files**: Small and focused (<800 lines), organized by feature
- **Functions**: <50 lines, clear names
- **Errors**: Always handle with try/catch, user-friendly messages
- **Security**: `shell: false` on spawn, validate all user input with zod
- **No console.log** (use console.error for actual errors only)
