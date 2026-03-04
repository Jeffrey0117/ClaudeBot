<p align="center">
  <img src="claudebot-logo.png" alt="ClaudeBot" width="160" />
</p>

<h1 align="center">ClaudeBot</h1>

<p align="center">
  <strong>Not a pipe to Claude. A command center on your phone.</strong>
</p>

<p align="center">
  <a href="README.zh-TW.md">繁體中文</a> | English
</p>

<p align="center">
  <a href="https://jeffrey0117.github.io/ClaudeBot/">Documentation</a> ·
  <a href="https://jeffrey0117.github.io/ClaudeBot/guide.html">Guide</a> ·
  <a href="https://github.com/Jeffrey0117/claudebot-plugins">Plugin Store</a>
</p>

---

Send a Telegram message. Claude rewrites your codebase. Stream the output live. Switch AI models mid-conversation. Queue 10 tasks and walk away. All from your phone.

No API keys. No cloud relay. ClaudeBot calls the CLI tools already on your machine — you own the entire pipeline.

## Why ClaudeBot?

Most "Telegram + AI" projects are thin wrappers — paste a prompt, get a response. ClaudeBot is a **platform**:

- **You send a message, AI edits your code** — real files, real git repos, full project context
- **Live streaming** — responses stream into Telegram in real-time, draft-style editing every 300ms
- **Multi-AI routing** — Claude for heavy lifting, Gemini for quick tasks, auto-router picks for you
- **Queue system** — fire off multiple requests, they execute in order with cross-bot mutex locks
- **Session memory** — conversations persist per-project via `--resume`, context never drops
- **Plugins at zero AI cost** — screenshots, dice, timers, system info, web search — instant, free
- **Multi-bot from one codebase** — run 5+ bots, add new ones with `/newbot` from Telegram
- **Voice-to-code** — speak into Telegram, local Sherpa-ONNX transcribes, AI executes
- **Remote pairing** — `/pair` a remote machine, AI reads & writes files there via WebSocket + MCP
- **AI directives** — Claude autonomously triggers commands, sends files, asks questions with buttons
- **4-layer memory** — bookmarks, pins, AI memory, and vault indexing keep context across sessions
- **Git worktree isolation** — multiple bots work on the same project simultaneously on separate branches
- **Deep analysis** — `/deep` switches to Opus + subagents for multi-angle investigation
- **Parallel execution** — `/parallel` runs multiple tasks concurrently in separate worktrees
- **Cross-project delegation** — AI detects when another project needs changes and auto-queues the task

## How It Compares

| | ClaudeBot | tmux bridge | API wrapper |
|---|---|---|---|
| Output | Real-time draft streaming (300ms) | After completion | N/A |
| Concurrency | Queue + cross-bot file lock | Single request | N/A |
| Auth | Chat ID + bcrypt + rate limit | None | API key |
| Multi-project | Session per project, auto-resume | Single session | N/A |
| UI | Buttons, suggestions, voice | Plain text | Web form |
| Extensibility | Plugin system + Plugin Store | Shell scripts | YAML config |
| Memory | 4-layer (bookmark/pin/AI/vault) | None | Stateless |
| Remote | WebSocket pairing with 10 MCP tools | SSH only | N/A |

## Architecture

```
Telegram ──> ClaudeBot ──> Claude / Gemini / Codex
  (you)          │              │
              Plugins       Projects ──> @run(other-project)
           (zero cost)         │
                          CloudPipe ──> Auto-deploy
```

## Features

### AI Directive System

Claude doesn't just reply — it **takes action**. The AI can embed directives in its responses that the bot intercepts and executes:

| Directive | What It Does | Example |
|-----------|-------------|---------|
| `@cmd(/command)` | Execute any bot command | `@cmd(/restart)`, `@cmd(/schedule bitcoin 09:00)` |
| `@file(path)` | Send a file to the user | `@file(report.md)` |
| `@confirm(q\|a\|b)` | Show inline buttons for choices | `@confirm(Which DB?\|PostgreSQL\|SQLite)` |
| `@notify(msg)` | Send a standalone notification | `@notify(Build complete, 0 errors)` |
| `@run(project)` | Delegate a task to another project | `@run(CloudPipe) update the endpoint` |
| `@pipe(service.action)` | Call CloudPipe APIs | `@pipe(monitor.status)` |

You say "set a daily Bitcoin alert at 9am" and Claude responds with a confirmation while silently executing `@cmd(/schedule bitcoin 09:00)`. It just works.

### 4-Layer Memory System

Context is the hardest problem in AI chat. ClaudeBot solves it with four complementary layers:

| Layer | Command | Persistence | Use Case |
|-------|---------|-------------|----------|
| **Bookmarks** | `/save` → 📌 | Per-project JSON | Quick recall of code snippets, configs |
| **Context Pins** | `/save` → 📎 | Auto-injected every prompt | "Always remember: we use Prisma, not Sequelize" |
| **AI Memory** | `/save` → 🧠 | External knowledge base | Long-term project knowledge |
| **Vault** | `/vault` | Message index | Search/recall any past conversation |

**Vault** silently indexes every message. When the AI loses context, `/vault inject` pulls relevant history back in. `/vault summary` generates a digest of today's conversation.

**Context Digest** — Claude generates a structured `[CTX]` block with every response (status, summary, pending items, next steps). When you reply with just "OK" or "好", the bot auto-injects this digest so Claude knows exactly what you were discussing.

### Smart UI

ClaudeBot turns Claude's responses into interactive Telegram UI:

- **Choice detection** — numbered lists with selection prompts become inline buttons
- **Yes/No detection** — questions at the end of responses get confirmation buttons
- **Follow-up suggestions** — after each response, AI generates 1-3 actionable next steps as buttons
- **Parallel task detection** — when you send a list of tasks, the bot suggests `/parallel` for concurrent execution

### Multi-Bot & Git Worktree

Run 5+ bot instances from one codebase. Each bot gets its own git worktree branch:

```
ProjectName/           ← main branch (production)
ProjectName--bot1/     ← bot1's worktree
ProjectName--bot2/     ← bot2's worktree
```

- `WORKTREE_BRANCH=bot1` in `.env` → auto-creates isolated worktree
- Queue, lock, and session all key on worktree path — zero conflicts
- `/deploy` on worktree → commit → merge to main → push

### Remote Pairing

Pair any machine to your bot. The AI operates on the remote filesystem via WebSocket:

```
Telegram → Bot (your PC) → WebSocket → Agent (remote machine)
                                          └── 10 MCP tools:
                                              read, write, list, search,
                                              grep, execute, system info,
                                              project overview, fetch, push
```

- `/pair code@192.168.1.50:3100` — connect
- `/grab /path/to/file` — download from remote
- `/rstatus` — check remote system health
- **Doc push** — send any file to the bot while paired → it lands on the remote machine

### Voice Pipeline

```
Telegram voice → OGG → ffmpeg 16kHz WAV → Sherpa-ONNX (local)
     → biaodian punctuation → optional Gemini refinement (⚡)
```

- Fully offline ASR — no API calls for basic transcription
- Ordered message buffer ensures voice + text arrive in exact send order
- `/asr on/off` toggles voice recognition per user

### Ordered Message Buffer

Messages arrive at the bot out of order (network latency, voice transcription delay). The buffer fixes this:

- Keyed by Telegram `message_id` (ascending) per chat
- Voice entries start as `pending` — block flush until transcribed
- 1-second text timer, 30-second staleness sweep
- Auto-flush on project switch

### Plugin Ecosystem

19+ built-in plugins, all at **zero AI cost** (no tokens consumed):

| Plugin | Command | What It Does |
|--------|---------|-------------|
| Browse | `/browse` | Browser automation via Chrome DevTools Protocol |
| Calc | `/calc` | Math, date math, unit conversion |
| Clip | `/save` `/recall` | Unified memory router (bookmark/pin/AI memory) |
| Cost | `/cost` `/usage` | API spend tracking per model and project |
| Dice | `/dice` `/coin` | Random numbers and coin flips |
| GitHub | `/star` `/follow` | Star repos, follow users, search |
| Map | `/map` | Location lookup → Google Maps link |
| MCP | `/mcp` | Connect to MCP servers, list & call external tools |
| Mdfix | `/mdfix` | Fix Telegram Markdown rendering issues |
| Remote | `/pair` `/grab` | Remote machine pairing & file transfer |
| Reminder | `/remind` | One-off timers (`5m`, `14:30`) |
| Scheduler | `/schedule` | Recurring daily tasks (e.g. Bitcoin price at 09:00) |
| Search | `/search` | Web search via SearXNG |
| Stats | `/stats` | Usage analytics — messages, models, projects, time series |
| Sysinfo | `/sysinfo` | CPU, memory, disk, network info |
| Task | `/task` | Daily task planner with time slots |
| Vault | `/vault` | Message indexing, search, context recall, summary |
| Write | `/write` | Quick note writing |

**Plugin Store** — browse and install community plugins from Telegram:
```
/store          ← browse available plugins
/install name   ← install from GitHub registry
/uninstall name ← remove
/reload         ← hot-reload without restart
```

### Productivity Tools

- **Todos** (`/todo`, `/todos`) — per-project task lists, `/todos all` for cross-project view
- **Ideas** (`/idea`, `/ideas`) — tag-categorized idea log with `#dev`, `#biz`, `#life` auto-icons
- **Task planner** (`/task`) — daily schedule with time slots, status indicators (✅🔔⏰⬜), auto-notification
- **Scheduler** (`/schedule`) — recurring daily pushes at fixed times
- **Reminders** (`/remind`) — one-off timers with relative (`5m`) or absolute (`14:30`) time

### Cross-Project Delegation

Claude can detect when a task spans multiple projects and auto-delegate:

```
You: "Update the API format and make ClaudeBot use the new format"
Claude: fixes ClaudeBot code, then:
  @run(CloudPipe) update the API endpoint to accept the new format
```

The bot auto-queues the task on the target project. Zero manual switching.

### CloudPipe Integration

If you run [CloudPipe](https://github.com/Jeffrey0117/CloudPipe), ClaudeBot can control it via `@pipe`:

```
@pipe(monitor.status)         ← check all monitored URLs
@pipe(monitor.add, URL)       ← add a health check
@pipe(gateway.tools)          ← list all cross-project MCP tools
@pipe(health)                 ← is CloudPipe running?
```

### Live Draft Streaming

Claude's response streams directly into the Telegram message — you see it being written in real-time:

- **300ms throttled edits** — smooth updates without API spam
- **Auto-strips internal metadata** — `[CTX]` blocks never leak into your view
- **Graceful fallback** — if editing fails, dirty draft is deleted and clean text sent fresh
- **Private chat only** — groups get final message to avoid notification spam

### Deep Analysis Mode

```
/deep analyze the auth module's security vulnerabilities
```

One command switches to maximum reasoning power:

- **Opus model** — strongest available Claude for deep thinking
- **2x turn limit** — more room for multi-step analysis
- **Subagent spawning** — Claude uses Task tool to explore from multiple angles (security, performance, architecture)
- Powered by `data/subagent-spec.md` — a hot-reloadable spec that teaches Claude when and how to use subagents

### Parallel Execution

```
/parallel
1. Add login page to frontend
2. Create user table in database
3. Write API auth endpoints
```

Each task gets its own git worktree and Claude CLI process. All run concurrently. Results merge back when done.

- `/parallel status` — check progress of all tasks
- `/parallel cancel` — abort everything
- Completion auto-merges each worktree branch back to main

### Context Digest & Hot-Reload

Every Claude response generates a structured `[CTX]` block (status, summary, pending, next steps). This is the AI's working memory:

- **Auto-injection** — when you reply "OK" or "好", the digest is injected so Claude never loses context
- `/ctx` — inspect what Claude currently remembers
- `/ctx clear` — reset the digest
- `/ctx reload` — hot-reload the context spec and subagent spec without restarting

### Additional Features

- **Web dashboard** — real-time bot monitoring, heartbeat tracking, runner status
- **Auto-commit** — timestamp-based git commits after AI completes work
- **`/deploy`** — one command: commit → merge worktree to main → push
- **`/sync`** — sync all worktree branches with master
- **`/claudemd`** — auto-generate `CLAUDE.md` project documentation
- **Bot bio auto-update** — Telegram bot description updates with current project & model
- **Image analysis** — send photos, Claude analyzes them with vision
- **Idle tidbits** — fun facts shown while waiting for long tasks
- **Smart restart** — AI auto-restarts the bot after code changes, notifies all users
- **Launcher admin notifications** — crash, respawn, startup events sent to your main bot chat

## Security

- **Chat ID + bcrypt** dual authentication
- **Rate limiting** per user
- **`shell: false`** on all process spawns
- **Input validation** with zod
- **Forbidden command protection** — prevents AI from running `taskkill /IM node.exe` (would kill itself)
- **Protected files** — `.env`, `.sessions.json`, `.pairings.json` cannot be deleted by AI
- **Cross-bot file lock** — prevents concurrent writes to the same project

## Quick Start

```bash
npx claudebot-app
```

One command — downloads, installs, runs setup wizard, starts the bot.

> **Prerequisites:** Node.js 20+, [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (logged in).
> Optional: Gemini CLI, ffmpeg (voice), Python 3.11+ (punctuation).

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/Jeffrey0117/ClaudeBot.git
cd ClaudeBot
npm install
npm run setup    # interactive wizard — creates .env
npm run dev
```

</details>

## Documentation

Full setup guide, plugin development, multi-bot architecture, voice recognition, and command reference:

**[jeffrey0117.github.io/ClaudeBot](https://jeffrey0117.github.io/ClaudeBot/)**

---

## Part of a Bigger Picture

ClaudeBot is one piece of a developer toolkit that covers your entire workflow — from setting up a new machine to shipping to production:

| Tool | What It Does | Repo |
|------|-------------|------|
| [**DevUp**](https://github.com/Jeffrey0117/DevUp) | New machine? One command rebuilds your entire workspace | `npx devup-cli` |
| [**ZeroSetup**](https://github.com/Jeffrey0117/ZeroSetup) | Any GitHub project, double-click to run. Zero setup steps | `npx zerosetup` |
| **ClaudeBot** | Write and edit code from your phone via AI | *you are here* |
| [**CloudPipe**](https://github.com/Jeffrey0117/CloudPipe) | Self-hosted Vercel. Auto-deploys, Telegram control, 31+ MCP tools | `npm i -g @jeffrey0117/cloudpipe` |
| [**MemoryGuy**](https://github.com/Jeffrey0117/MemoryGuy) | Memory leak detection, safe optimization, port dashboard | Electron app |

**ClaudeBot + CloudPipe** = you write code from Telegram, CloudPipe auto-deploys it, and notifies you when it's live. Idea to production without opening a laptop.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Jeffrey0117/ClaudeBot&type=date&legend=top-left)](https://www.star-history.com/?repos=Jeffrey0117%2FClaudeBot&type=date&legend=top-left)

## License

MIT
