# src/remote — Remote Pairing

## Architecture

```
Telegram → Bot (A-side) → relay-server.ts → WebSocket → agent.ts (N-side)
                                                          └── tool-handlers.ts (10 MCP tools)
```

## Components
- `relay-server.ts` — WebSocket relay, handles pairing handshake
- `agent.ts` — runs on remote machine, connects back to relay
- `protocol.ts` — message types and serialization
- `tool-handlers.ts` — 10 tools: read, write, list, search, grep, execute, sysinfo, overview, fetch, push

## Commands
- `/pair code@ip:port` — connect to remote agent
- `/unpair` — disconnect
- `/rpair` — restart remote agent
- `/grab /path` — download file from remote
- Doc push: send any file to bot while paired → lands on remote

## State
- `pairings.json` — per-bot pairing state
- Fallback: `state.selectedProject ?? (getPairing(...)?.connected ? remote : null)`
- Per-instance isolation via BOT_ID
