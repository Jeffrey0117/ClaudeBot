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

---

Control [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) remotely via Telegram. Manage projects, stream responses in real time, run plugins — all from your pocket.

Claude is the engine. The dashboard, queue, plugins, and interactive UI are yours.

## Features

| Feature | Description |
|---------|-------------|
| **Real-time streaming** | Live status every second — elapsed time, tool count, tool names |
| **Multi-AI backend** | Claude, Gemini, Codex — switch with `/model`, or let auto-routing decide |
| **Multi-project workspace** | One session per project with automatic `--resume`. Instant switching |
| **Queue system** | Send multiple requests — they execute in order with cross-bot file locking |
| **Interactive responses** | Confirm buttons for questions, smart follow-up suggestions for answers |
| **Cross-project delegation** | `@run(project) prompt` lets Claude chain tasks across repos autonomously |
| **Multi-bot** | Run 4+ bots from one codebase. Add new bots from Telegram with `/newbot` |
| **Plugin system** | Screenshots, dice, reminders, sysinfo, cost tracking — instant, zero AI cost |
| **Dashboard** | Web control panel with live runner status and heartbeat monitoring |
| **Security** | Chat ID whitelist, bcrypt auth, rate limiting, `shell: false` spawning |

## How It Compares

| | ClaudeBot | tmux bridge | API proxy |
|---|---|---|---|
| Real-time output | Live streaming with tool progress | After completion only | N/A |
| Queue & concurrency | Full queue + cross-bot mutex | Single request | N/A |
| Authentication | Chat ID + bcrypt + rate limit | None | API key |
| Multi-project | Session per project, auto-resume | Single session | N/A |
| Interactive UI | Buttons + suggestions | Plain text | Web dashboard |
| Extensibility | Plugin system | Shell scripts | YAML config |

## Architecture

```
Telegram ──> ClaudeBot ──> Claude / Gemini / Codex
  (you)          │              │
              Plugins       Projects
           (zero cost)    (via @run)
```

- **Plugins** extend the bot — instant commands without AI (`/screenshot`, `/sysinfo`, `/cost`, `/remind`)
- **Projects** extend Claude — each repo is a workspace with full context and session history

## Quick Start

### Prerequisites

- **Node.js** >= 18 ([download](https://nodejs.org/))
- **Claude CLI** installed and logged in:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude    # follow the login prompts
  ```
- **Gemini CLI** (optional — enables Gemini backend):
  ```bash
  npm install -g @anthropic-ai/claude-code
  gemini    # login to your Google account
  ```

> ClaudeBot works by calling CLI tools on your machine — no API keys needed. Just install the CLI and log in.

### Setup

```bash
git clone https://github.com/Jeffrey0117/ClaudeBot.git
cd ClaudeBot
npm install
npm run setup    # interactive wizard — creates .env for you
npm run dev
```

That's it. The setup wizard walks you through:
1. Creating a Telegram bot via [@BotFather](https://t.me/BotFather)
2. Getting your chat ID from [@userinfobot](https://t.me/userinfobot)
3. Setting your projects directory, password, model, and plugins

<details>
<summary><strong>Manual setup (without wizard)</strong></summary>

```bash
cp .env.example .env
# Edit .env with your values
npm run dev
```

</details>

### Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_TOKEN` | Yes | — | Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `ALLOWED_CHAT_IDS` | Yes | — | Comma-separated Telegram chat IDs |
| `PROJECTS_BASE_DIR` | Yes | — | Comma-separated base directories for projects |
| `PLUGINS` | No | — | Comma-separated plugin names to enable |
| `LOGIN_PASSWORD` | No\* | — | Plain text login password |
| `LOGIN_PASSWORD_HASH` | No\* | — | Bcrypt hash (recommended for production) |
| `AUTO_AUTH` | No | `true` | Auto-authenticate whitelisted chats |
| `DEFAULT_MODEL` | No | `sonnet` | Default model (`haiku` / `sonnet` / `opus`) |
| `GEMINI_API_KEY` | No | — | Gemini API key (only if using API mode) |
| `DASHBOARD` | No | `false` | Enable web dashboard |
| `RATE_LIMIT_MAX` | No | `10` | Max messages per window |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit window (ms) |
| `MAX_TURNS` | No | — | Max Claude conversation turns |
| `ANTHROPIC_ADMIN_KEY` | No | — | Admin API key for `/usage` org-level billing |

\* Password is optional when `AUTO_AUTH=true`. When `AUTO_AUTH=false`, one of `LOGIN_PASSWORD` or `LOGIN_PASSWORD_HASH` is required.

## Commands

### Core

| Command | Description |
|---------|-------------|
| `/projects` | Browse & select a project |
| `/select <name>` | Quick switch project |
| `/model` | Switch model (haiku/sonnet/opus) or backend (claude/gemini) |
| `/status` | Show queue & active projects |
| `/cancel` | Stop current process |
| `/new` | Fresh session (clear history) |
| `/chat` | General conversation (no project) |
| `/newbot <token>` | Add a new bot instance from Telegram |
| `/restart` | Remote bot restart |

### Bookmarks

| Command | Description |
|---------|-------------|
| `/fav` | Manage bookmarks |
| `/fav add` | Bookmark current project |
| `/1` ~ `/9` | Switch to bookmarked project |

### Todos

| Command | Description |
|---------|-------------|
| `/todo <text>` | Add todo to current project |
| `/todo @project <text>` | Add todo to another project |
| `/todos` | List todos |
| `/todos <n>` | Toggle done status |
| `/todos done` | Clear completed |

### Cross-Project

| Command | Description |
|---------|-------------|
| `/run <project> <prompt>` | Execute task on another project |
| `/mkdir <name>` | Create new project folder |

Claude can also delegate autonomously — when its response contains `@run(projectName) description`, the bot auto-enqueues the task.

### Tips

- Send any text to chat with Claude in the selected project
- Prefix with `!` to interrupt current process and redirect
- Messages within 2s are batched together
- Send photos/documents — Claude can see them
- Use `@chat <message>` for one-shot general conversations

## Plugin System

Plugins run without AI — instant, zero cost.

```env
PLUGINS=screenshot,sysinfo,dice,reminder,browse,cost
```

| Plugin | Commands | Description |
|--------|----------|-------------|
| `screenshot` | `/screenshot` | Desktop & web page capture |
| `sysinfo` | `/sysinfo` | CPU, GPU, memory, disk info |
| `dice` | `/dice`, `/coin` | Roll dice, flip coins |
| `reminder` | `/remind` | Gym timer with preset buttons |
| `browse` | `/browse` | Web page browsing |
| `cost` | `/cost`, `/usage` | Session cost tracking & Anthropic billing |

<details>
<summary><strong>Creating your own plugin</strong></summary>

Add a folder to `src/plugins/` with an `index.ts`:

```typescript
import type { Plugin } from '../../types/plugin.js'

const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'What it does',
  commands: [
    {
      name: 'mycommand',
      description: 'Command description',
      handler: async (ctx) => {
        await ctx.reply('Hello from plugin!')
      },
    },
  ],
}

export default myPlugin
```

Add the folder name to `PLUGINS` in `.env`. The bot auto-registers commands and updates `/help`.

</details>

## Multi-Bot & Groups

### Adding bots from Telegram

The easiest way to add more bots:

1. Go to [@BotFather](https://t.me/BotFather) and create a new bot
2. Copy the token
3. In your existing bot, send: `/newbot <token> [password]`
4. Send `/restart` to bring the new bot online

The `/newbot` command auto-creates a `.env.botN` file with your existing settings.

### Manual setup

```bash
# Create .env.bot2 manually
cp .env .env.bot2
# Edit BOT_TOKEN and other values
npm run dev    # launches all bots
```

Add bots to a Telegram group for team workflows — **@mention routing** sends tasks to specific bots. Each bot shows its current project in its bio.

## Production

```bash
npm install -g pm2
pm2 start npm --name claudebot -- run dev
pm2 save && pm2 startup
```

## Tech Stack

Telegraf v4 · TypeScript · Playwright · bcrypt · zod

## License

MIT
