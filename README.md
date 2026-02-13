# ClaudeBot

Telegram bot to remotely control Claude Code CLI from your phone.

Send prompts, get streaming responses, manage multiple projects -- all from Telegram.

## Setup

```bash
npm install
cp .env.example .env   # edit with your values
npm run dev
```

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

\* When `AUTO_AUTH=true`, password is optional. When `AUTO_AUTH=false`, one of `LOGIN_PASSWORD` or `LOGIN_PASSWORD_HASH` is required.

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

## Data

Bookmarks and todos persist in `data/` (git-ignored):
- `data/bookmarks.json` -- project bookmarks per chat
- `data/todos.json` -- todos per project

## Tech Stack

Telegraf v4 + TypeScript + bcrypt + zod
