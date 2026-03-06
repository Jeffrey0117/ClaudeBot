# src/remote — Remote Pairing

## Architecture

```
Telegram → Bot (A-side) → relay-server.ts → WebSocket → agent.ts (N-side)
                                                          └── tool-handlers.ts (10 MCP tools)
```

## Components
- `relay-server.ts` — WebSocket relay, handles pairing handshake + `callAgentTool()` for bot-initiated tool calls
- `agent.ts` — runs on remote machine, connects back to relay
- `protocol.ts` — message types and serialization
- `tool-handlers.ts` — 11 tools: read, write, list, search, grep, execute, sysinfo, overview, fetch, push, list_projects

## Commands
- `/pair code@ip:port` — connect to remote agent
- `/unpair` — disconnect
- `/rpair` — restart remote agent
- `/projects` — remote-only users: list project folders on agent's machine
- `/grab /path` — download file from remote
- Doc push: send any file to bot while paired → lands on remote

## Remote-Only Users
- `REMOTE_CHAT_IDS` env var — users can only access bot through pairing
- Whitelisted commands: `/start`, `/login`, `/help`, `/status`, `/cancel`, `/new`, `/pair`, `/unpair`, `/model`, `/projects`, `/select`, `/chat`
- All other commands blocked with "🚫 遠端帳號無法使用此指令"

## Bot-Initiated Tool Calls
- `callAgentTool(code, tool, args)` — bot calls agent tools directly (not via MCP proxy)
- Uses request IDs starting at 900,000 to avoid collision with proxy requests
- Used by `/projects` to list remote directories

## State
- `pairings.json` — per-bot pairing state
- Fallback: `state.selectedProject ?? (getPairing(...)?.connected ? remote : null)`
- Per-instance isolation via BOT_ID
- Remote project path convention: `remote:${folderName}`
