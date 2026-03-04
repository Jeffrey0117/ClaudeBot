# ClaudeBot

Telegram bot that wraps Claude Code CLI into a mobile command center.
Not a pipe to Claude — a platform with plugins, queue, multi-project, and interactive UI.

## Stack
- **Runtime**: Node.js + TypeScript (strict)
- **Bot framework**: Telegraf v4
- **Validation**: zod
- **Auth**: bcrypt (dual: plain password or hash)
- **Entry**: `src/launcher.ts` → spawns 1–N bot instances from `.env`, `.env.bot2`, etc.

## Architecture at a glance

```
src/
  launcher.ts          ← Multi-bot launcher
  bot/                 ← Core: commands, handlers, middleware, queue, data stores
  claude/              ← Claude CLI runner + session store + file lock
  ai/                  ← Multi-backend AI (Claude, Gemini) + session store
  plugins/             ← Plugin system (hot-reloadable)
  remote/              ← Remote pairing: relay server, agent, protocol, tools
  git/                 ← Git worktree management (multi-bot parallel dev)
  asr/                 ← Sherpa-ONNX voice recognition
  config/              ← env, projects scanner
  telegram/            ← Telegram helpers (message splitting, etc.)
  utils/               ← System prompt, choice detector, path validator
  dashboard/           ← Web dashboard (heartbeat, command reader)
  mcp/                 ← MCP server integration
  types/               ← Shared TypeScript types
```

## Key patterns

### Queue + Session
- One Claude CLI process per bot at a time (`src/claude/queue.ts`)
- `--resume <session_id>` keeps conversation context
- Session IDs in `.sessions.json`, keyed by `${BOT_ID}:${projectPath}`
- BOT_ID = last 6 chars of bot token → per-instance isolation

### Multi-backend AI
`/model` → auto/claude:sonnet/claude:opus/gemini:flash. `src/ai/registry.ts` routes.

### Context preservation
- Short replies (≤15 chars) or affirmative (≤80 chars, 好/OK/嗯…) auto-inject `[前次回覆參考]`
- Prevents amnesia after context compression

### Voice pipeline
OGG → ffmpeg 16kHz WAV → Sherpa ASR → biaodian punctuation → optional Gemini refinement (⚡).

### Stream output
`--output-format stream-json` parsed line-by-line. Telegram edited with 1s debounce, 4096 char limit.

### Plugin system
`src/plugins/<name>/index.ts`, `PLUGINS=` env var, hot-reload via `/reload`, Plugin Store (`/store`).

### Multi-bot + Worktree
`src/launcher.ts` spawns per `.env.botN`. `WORKTREE_BRANCH=bot1` → git worktree isolation.

### Remote pairing
```
Telegram → Bot (A-side) → relay-server.ts → WS → agent.ts (N-side) → tool-handlers.ts (10 tools)
```
`/pair`, `/unpair`, `/rpair`, `/grab`. Doc push: send file to bot while paired.
Remote mode fallback: `state.selectedProject ?? (getPairing(...)?.connected ? remote : null)`.

### CloudPipe integration
`@pipe(tool, params)` directive calls CloudPipe gateway API.
- `src/utils/cloudpipe.ts` — Gateway client (GET /api/gateway/tools, POST /api/gateway/call)
- `src/utils/directives.ts` — Parses `@pipe` and auto-executes CloudPipe tools
- `.env`: `CLOUDPIPE_URL`, `CLOUDPIPE_SERVICE_TOKEN` (optional)
- Example: `@pipe(repic_remove_background, url=https://...)` → returns processed image

## Coding rules

- **Immutability**: Always create new objects, never mutate
- **Files**: Small and focused (<800 lines), organized by feature
- **Functions**: <50 lines, clear names
- **Errors**: Always handle with try/catch, user-friendly messages
- **Security**: `shell: false` on spawn, validate all user input with zod
- **No console.log in production** (use console.error for actual errors only)

## Commands overview

### Core
/projects, /select, /model, /status, /cancel, /new, /fav,
/todo, /todos, /idea, /ideas, /run, /chat, /newbot,
/store, /install, /uninstall, /reload, /asr, /context,
/restart, /deploy, /pair, /unpair, /rpair, /grab,
/claudemd, /rstatus, /rlog, /help

### Plugins
browse, calc, cost, dice, github, map, mcp, mdfix,
reminder, remote, scheduler, screenshot, search, stats,
sysinfo, task, write

## Adding a new plugin

Create `src/plugins/<name>/index.ts`, export default `Plugin` object:

```typescript
import type { Plugin } from '../../types/plugin.js'
const plugin: Plugin = {
  name: '<name>',
  description: '簡短描述',
  commands: [{ name: '<cmd>', description: '指令說明', handler: myCommand }],
}
export default plugin
```

1. Add to `PLUGINS=` in `.env` → `/reload` or restart
2. Publish to Plugin Store: `Jeffrey0117/claudebot-plugins` (upload source + update `registry.json`)
