# ClaudeBot

**Not a pipe to Claude. A command center on your phone.**

Control Claude Code CLI, manage projects, run plugins -- all from Telegram. Claude is the engine, but the dashboard, buttons, and toolbox are yours.

## Features

**Real-time streaming** -- See Claude's progress live. Status updates every second with elapsed time, tool count, and tool names. No waiting until the end.

**Multi-project workspace** -- Switch between projects instantly. Each project maintains its own Claude session with automatic `--resume` continuity. Cross-project delegation via `@run(project) prompt` lets Claude autonomously chain tasks across repos.

**Queue system** -- Send multiple requests without waiting. They execute in order. Cross-bot file locking prevents two bots from modifying the same project simultaneously.

**Interactive responses** -- Claude's yes/no questions get confirm buttons. Non-question responses get smart follow-up suggestions generated contextually.

**Multi-bot support** -- Run 4+ bots from one codebase with separate `.env` files. Single launcher starts them all. Add bots to a Telegram group with @mention routing for team-style workflows.

**Plugin system** -- Extend the bot without Claude. Screenshots, dice, reminders, system info -- lightweight commands that run instantly. Drop a folder in `src/plugins/` to add your own.

**Security** -- Whitelist-based chat ID restriction, optional bcrypt password auth, rate limiting, and `shell: false` process spawning to prevent command injection.

**Quality of life** -- Message batching (2s window), `!` prefix to interrupt and redirect, image support (send and receive), idle entertainment during long waits, 120s long-running task reminder with `/cancel` hint, bookmarks for quick project switching, per-project todos.

## How It Compares

| | ClaudeBot | tmux bridge approach | API proxy approach |
|---|---|---|---|
| **Real-time output** | Live streaming with tool progress | Response only after completion | N/A (different layer) |
| **Queue & concurrency** | Full queue with cross-bot mutex | Single request, no queue | N/A |
| **Authentication** | Chat ID + bcrypt + rate limit | None | API key based |
| **Multi-project** | Session per project, auto-resume | Single tmux session | N/A |
| **Interactive UI** | Confirm buttons + suggestions | Plain text | Web dashboard |
| **Extensibility** | Plugin system | Shell scripts | YAML config |
| **Setup** | `npm install && npm run dev` | tmux + Cloudflare Tunnel + hooks | Go binary + YAML config |

## Architecture

```
Telegram  -->  ClaudeBot  -->  Claude CLI
  (you)          |                |
               Plugins        Projects
             (built-in)     (via @run)
```

Everything is pluggable:

- **Plugins** -- built-in capabilities (`/screenshot`, `/sysinfo`, `/dice`, ...). Lightweight, instant, no Claude needed. Enable/disable via `.env`.
- **Projects** -- your code repos, each a self-contained workspace. Claude operates inside them with full context. Cross-project delegation via `/run` or `@run()`.

Plugins extend the bot. Projects extend Claude.

## Prerequisites

- **Node.js** >= 18 ([download](https://nodejs.org/))
- **Claude CLI** -- install and login:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude    # first run will prompt you to login
  ```

## Quick Start

```bash
# 1. Clone
git clone https://github.com/Jeffrey0117/ClaudeBot.git
cd ClaudeBot

# 2. Install dependencies
npm install

# 3. Create config
cp .env.example .env
```

Edit `.env` with your values (see below), then:

```bash
# 4. Run
npm run dev
```

## Getting Your Config Values

### BOT_TOKEN

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`, follow the prompts to name your bot
3. Copy the token it gives you (looks like `123456789:ABCdefGHI...`)

> Each bot token = one bot instance. If running on multiple machines, create a separate bot for each.

### ALLOWED_CHAT_IDS

1. Open Telegram, search for **@userinfobot**
2. Send any message, it will reply with your **ID** (a number like `123456789`)
3. For group chats: add @userinfobot to the group, it will show the group's chat ID

### PROJECTS_BASE_DIR

The folder(s) containing your code projects. Supports multiple paths (comma-separated):

```
# Single directory
PROJECTS_BASE_DIR=C:\Users\yourname\Desktop\code

# Multiple directories
PROJECTS_BASE_DIR=C:\Users\yourname\Desktop\code,D:\projects
```

The bot lists all subdirectories as selectable projects.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_TOKEN` | Yes | -- | Telegram bot token from @BotFather |
| `ALLOWED_CHAT_IDS` | Yes | -- | Comma-separated Telegram chat IDs |
| `PROJECTS_BASE_DIR` | Yes | -- | Comma-separated base directories for projects |
| `PLUGINS` | No | -- | Comma-separated plugin names to enable |
| `LOGIN_PASSWORD` | No* | -- | Plain text login password |
| `LOGIN_PASSWORD_HASH` | No* | -- | Bcrypt hash (recommended for production) |
| `AUTO_AUTH` | No | `true` | Auto-authenticate whitelisted chats |
| `DEFAULT_MODEL` | No | `sonnet` | Default Claude model (`haiku`/`sonnet`/`opus`) |
| `RATE_LIMIT_MAX` | No | `10` | Max messages per window |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit window in ms |
| `MAX_TURNS` | No | -- | Max Claude conversation turns |

\* When `AUTO_AUTH=true` (default), password is optional. When `AUTO_AUTH=false`, one of `LOGIN_PASSWORD` or `LOGIN_PASSWORD_HASH` is required.

### Minimal .env Example

```env
BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
ALLOWED_CHAT_IDS=123456789
PROJECTS_BASE_DIR=C:\Users\yourname\Desktop\code
PLUGINS=screenshot,sysinfo,dice,reminder
```

## Commands

### Core
| Command | Description |
|---------|-------------|
| `/start` | Welcome message + quick access bookmarks |
| `/login <password>` | Authenticate (not needed with AUTO_AUTH) |
| `/logout` | Log out |
| `/projects` | Browse & select a project |
| `/select <name>` | Quick switch project by name |
| `/cd <path>` | Switch working directory |
| `/model` | Switch model (haiku/sonnet/opus) |
| `/status` | Show active projects & queue |
| `/cancel` | Stop current process |
| `/new` | Fresh session (clear history) |
| `/chat` | General conversation (no project needed) |
| `/help` | List all commands |

### Bookmarks
| Command | Description |
|---------|-------------|
| `/fav` | Show bookmarks with manage buttons |
| `/fav add` | Bookmark the current project |
| `/fav remove <slot>` | Remove bookmark from slot |
| `/1` ~ `/9` | Switch to bookmarked project |

### Todos
| Command | Description |
|---------|-------------|
| `/todo <text>` | Add todo to current project |
| `/todo @project <text>` | Add todo to a specific project |
| `/todos` | List todos for current project |
| `/todos <number>` | Toggle a todo's done status |
| `/todos done` | Clear all completed todos |

### Cross-Project
| Command | Description |
|---------|-------------|
| `/run <project> <prompt>` | Execute a task on another project |
| `/mkdir <name>` | Create a new project folder |

Claude can also delegate across projects autonomously. When Claude's response contains `@run(projectName) description`, the bot auto-enqueues that task on the target project. This enables multi-project workflows from a single prompt.

### Usage Tips
- Send any text message to chat with Claude in the selected project
- Prefix with `!` to cancel current process and redirect
- Multiple messages within 2s are batched together
- Send photos/documents -- Claude can see them
- Each project maintains its own Claude session
- Use `@chat <message>` for one-shot general conversations

## Plugin System

Plugins add capabilities to the bot without going through Claude. Enable them in `.env`:

```env
PLUGINS=screenshot,sysinfo,dice,reminder
```

### Built-in Plugins

| Plugin | Commands | Description |
|--------|----------|-------------|
| `screenshot` | `/screenshot` | Desktop & web page capture |
| `sysinfo` | `/sysinfo` | CPU, GPU, memory, disk info |
| `dice` | `/dice`, `/coin` | Roll dice, flip coins |
| `reminder` | `/remind` | Set timed reminders |

### Screenshot Usage

```
/screenshot           # Capture all screens
/screenshot 1         # Capture screen 1
/screenshot list      # List available screens
/screenshot <URL>     # Capture a web page
/screenshot <URL> full  # Full-page web capture
```

Images detected in Claude's responses are automatically sent back as photos.

### Creating Plugins

Each plugin is a folder in `src/plugins/` with an `index.ts` default export:

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

Add the folder name to `PLUGINS` in `.env` to enable it. The bot auto-registers commands and updates `/help`.

## Multi-Bot & Group Support

### Multiple Bots

Each machine needs its own bot (Telegram limits one instance per token):

1. Create a **new bot** via @BotFather (new token)
2. Use a separate `.env` file (`.env.bot2`, `.env.bot3`, ...)
3. Run each with: `npx tsx src/index.ts` (with `DOTENV_CONFIG_PATH` pointing to the right file)

Both bots work independently from the same Telegram account.

### Groups

Add multiple bots to a Telegram group for team-style workflows:

- **@mention routing** -- `@MyBot fix the login bug` routes to that specific bot
- **Dynamic Bio** -- each bot updates its description to show the current project
- **Pin status** -- project/model info pinned in the chat

## Keep Running (Production)

Use [pm2](https://pm2.keymetrics.io/) to keep the bot alive:

```bash
npm install -g pm2
pm2 start npm --name claudebot -- run dev
pm2 save
pm2 startup   # auto-start on boot
```

## Data

Bookmarks and todos persist in `data/` (git-ignored):
- `data/bookmarks.json` -- project bookmarks per chat
- `data/todos.json` -- todos per project

## Tech Stack

Telegraf v4 + TypeScript + Playwright + bcrypt + zod
