# src/plugins — Plugin System

## Architecture
- Each plugin: `src/plugins/<name>/index.ts`, exports `Plugin` object
- `PLUGINS=` env var controls which are loaded
- Hot-reload via `/reload`, Plugin Store via `/store`
- `loader.ts` handles registration, dispatch, output hooks

## Plugin interface

```typescript
import type { Plugin } from '../../types/plugin.js'
const plugin: Plugin = {
  name: '<name>',
  description: '簡短描述',
  commands: [{ name: '<cmd>', description: '指令', handler: fn }],
  onMessage?: async (ctx) => boolean,   // return true = consumed
  onCallback?: async (ctx, data) => boolean,
  outputHook?: (text, meta) => { text, warnings },
}
export default plugin
```

## Current plugins
allot, browse, calc, clip, cost, dice, github, map, mcp, mdfix,
reminder, remote, scheduler, screenshot, search, stats,
sysinfo, task, vault, write

## Adding a new plugin
1. Create `src/plugins/<name>/index.ts`
2. Add to `PLUGINS=` in `.env`
3. `/reload` or restart
4. Optional: publish to `Jeffrey0117/claudebot-plugins`

## Notable plugins

### clip (`/save`, `/recall`)
Unified memory router — shows 3 inline buttons (📌 bookmark, 📎 pin, 🧠 AI memory).
`pendingSaves` Map holds text until user picks mode via callback.

### vault (`/vault`)
Silent message indexer. `index-store.ts` (metadata JSON), `message-indexer.ts` (onMessage hook).
Features: search, inject (context recall), fwd, summary, tag, stats.

### allot (`/allot`)
Remote quota management — admin only. Dual-layer: rate limit (turns/5min sliding window) + weekly budget (turns/7day).
Shared across all bot instances via `mainRepoPath()`. Auto-adaptive: +2 on clean windows, -10 on 429.
Hooks into `message-handler.ts` (pre-enqueue gate) and `queue-processor.ts` (settle + 429 detection).

### stats (`/stats`)
Git scanner across all projects + activity logger. Deduplicates worktrees by git common dir.
Subcommands: today, week, month, year, hours, projects, custom ranges (3d/2w/2025-02).
