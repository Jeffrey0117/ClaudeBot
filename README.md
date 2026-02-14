# ClaudeBot

Telegram bot to remotely control Claude Code CLI from your phone.

Send prompts, get streaming responses, manage multiple projects -- all from Telegram.

## Prerequisites

- **Node.js** >= 18 ([download](https://nodejs.org/))
- **Claude CLI** -- install and login:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude    # first run will prompt you to login
  ```

## Quick Start (New Machine)

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

The folder that contains all your code projects:

```
# Windows
PROJECTS_BASE_DIR=C:\Users\yourname\Desktop\code

# macOS
PROJECTS_BASE_DIR=/Users/yourname/code

# Linux
PROJECTS_BASE_DIR=/home/yourname/code
```

The bot will list all subdirectories in this folder as selectable projects.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_TOKEN` | Yes | -- | Telegram bot token from @BotFather |
| `ALLOWED_CHAT_IDS` | Yes | -- | Comma-separated Telegram chat IDs |
| `PROJECTS_BASE_DIR` | Yes | -- | Base directory containing your projects |
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
PROJECTS_BASE_DIR=C:\Users\jeffb\Desktop\code
```

That's it -- `AUTO_AUTH` defaults to `true`, so no password needed.

## Commands

### Core
| Command | Description |
|---------|-------------|
| `/start` | Welcome message + quick access bookmarks |
| `/login <password>` | Authenticate (not needed with AUTO_AUTH) |
| `/logout` | Log out |
| `/projects` | Browse & select a project |
| `/select <name>` | Quick switch project by name |
| `/model` | Switch model (haiku/sonnet/opus) |
| `/status` | Show active projects & queue |
| `/cancel` | Stop current process |
| `/new` | Fresh session (clear history) |
| `/help` | List all commands |

### Bookmarks
| Command | Description |
|---------|-------------|
| `/fav` | Show bookmarks with manage buttons |
| `/fav add` | Bookmark the current project |
| `/fav remove <slot>` | Remove bookmark from slot |
| `/1` ~ `/9` | Switch to bookmarked project |

Quick workflow:
1. `/projects` -- select a project
2. `/fav add` -- bookmark it
3. Next time, just type `/1` to switch instantly

### Todos
| Command | Description |
|---------|-------------|
| `/todo <text>` | Add todo to current project |
| `/todo @project <text>` | Add todo to a specific project |
| `/todos` | List todos for current project |
| `/todos @project` | List todos for a specific project |
| `/todos <number>` | Toggle a todo's done status |
| `/todos done` | Clear all completed todos |

### Usage Tips
- Send any text message to chat with Claude in the selected project
- Prefix with `!` to cancel current process and redirect
- Multiple messages within 2s are batched together
- Send photos/documents -- Claude can see them
- Each project maintains its own Claude session

## Running on Multiple Machines

Each machine needs its own bot (Telegram limits one instance per token):

1. Create a **new bot** via @BotFather (new token)
2. Clone this repo, `npm install`, configure `.env` with the new token
3. Make sure Claude CLI is installed and logged in on that machine

Both bots work independently -- you can use them at the same time from the same Telegram account.

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

Telegraf v4 + TypeScript + bcrypt + zod
