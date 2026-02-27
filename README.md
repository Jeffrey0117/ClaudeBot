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
- **Live streaming** — watch tool calls, elapsed time, and progress update every second
- **Multi-AI routing** — Claude for heavy lifting, Gemini for quick tasks, auto-router picks for you
- **Queue system** — fire off multiple requests, they execute in order with cross-bot mutex locks
- **Session memory** — conversations persist per-project via `--resume`, context never drops
- **Plugins at zero AI cost** — screenshots, dice, timers, system info, web search — instant, free
- **Multi-bot from one codebase** — run 4+ bots, add new ones with `/newbot` from Telegram
- **Voice-to-code** — speak into Telegram, local Sherpa-ONNX transcribes, AI executes

## How It Compares

| | ClaudeBot | tmux bridge | API wrapper |
|---|---|---|---|
| Output | Live streaming with tool progress | After completion | N/A |
| Concurrency | Queue + cross-bot file lock | Single request | N/A |
| Auth | Chat ID + bcrypt + rate limit | None | API key |
| Multi-project | Session per project, auto-resume | Single session | N/A |
| UI | Buttons, suggestions, voice | Plain text | Web form |
| Extensibility | Plugin system + Plugin Store | Shell scripts | YAML config |

## Architecture

```
Telegram ──> ClaudeBot ──> Claude / Gemini / Codex
  (you)          │              │
              Plugins       Projects
           (zero cost)    (via @run)
```

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

## License

MIT
