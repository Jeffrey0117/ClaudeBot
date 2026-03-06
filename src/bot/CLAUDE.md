# src/bot — Core Bot Logic

## Queue Processor Pipeline (`queue-processor.ts`)

Claude's response flows through this pipeline:

```
Claude response → parse all directives
  → execute @file/@confirm/@notify
  → execute @pipe (CloudPipe)
  → strip ALL directives from text
  → output hooks (mdfix, etc.)
  → extract [CTX] digest
  → send response text to Telegram
  → execute @cmd LAST (restart confirms appear below response)
```

## AI Directives (`../utils/`)

| Directive | Handler | Purpose |
|-----------|---------|---------|
| `@cmd(/command)` | `command-executor.ts` | Execute bot commands via fake context (60s timeout) |
| `@file(path)` | `directives.ts` | Send file to user |
| `@confirm(q\|a\|b)` | `directives.ts` | Inline buttons → selection re-enqueued |
| `@notify(msg)` | `directives.ts` | Standalone 🔔 notification |
| `@pipe(svc.action)` | `pipe-executor.ts` | CloudPipe HTTP API call |
| `@run(project) task` | `cross-project-parser.ts` | Cross-project delegation |

## Context Digest ([CTX] system)
- Claude generates `[CTX]` blocks (status/summary/pending/next/files) every response
- `context-digest-store.ts` stores, strips from display text
- Auto-injected when user sends short/affirmative replies → prevents amnesia
- `last-response-store.ts` provides `[前次回覆參考]` injection

## Ordered Message Buffer (`ordered-message-buffer.ts`)
- Buffers text+voice per chat, keyed by Telegram message_id (ascending)
- Voice entries start `pending` → block flush until transcribed
- 1s text timer, 30s staleness sweep, forceFlush on project switch

## 4-Layer Memory
1. **Bookmarks** (`/save` → 📌) — clip plugin, `data/clips.json`, `/recall`
2. **Context Pins** (`/save` → 📎) — `context-pin-store.ts`, auto-injected every prompt
3. **AI Memory** (`/save` → 🧠) — claude-mem external tool
4. **Vault** (`/vault`) — message indexer (`../plugins/vault/`)

## Allot Integration (remote quota)
- `message-handler.ts` + `ordered-message-buffer.ts` — pre-enqueue gate via `getPluginModule('allot')?.tryReserve()`
- `queue-processor.ts` — post-completion settle via `settle()`, 429 detection via `on429Detected()`
- Only applies when `project.name === 'remote'` — local requests always pass

## Key Data Stores
- `state.ts` — selected project, AI model, pairing per chat
- `choice-store.ts` — inline button callback mapping
- `suggestion-store.ts` — AI-generated follow-up suggestions
- `context-pin-store.ts` — persistent context pins per project
- `bookmarks.ts` — favorite project shortcuts
