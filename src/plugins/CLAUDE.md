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
allot, browse, calc, chain, clip, cost, dice, github, map, mcp, mdfix,
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

### chain (`/chain`)
指令鏈系統 — 串聯多步驟自動執行。

**定位**: 把 bv、pipe、cmd 等能力串成工作流，上一步的輸出自動流入下一步。

**步驟類型**:
| 前綴 | 用途 | 適合場景 |
|------|------|----------|
| `bv` | 網頁自動化（把別人的網站變 API） | 新聞/部落格/公開資料頁/無反爬的站 |
| `pipe` | CloudPipe API 呼叫 | 自己的服務、rawtxt、gateway tools |
| `cmd` | 執行 bot 指令 | `/stats`、`/deploy` 等 |
| `notify` | 發 Telegram 訊息 | 通知結果 |
| `wait` | 延遲 N 秒（上限 300s） | 等待頁面/服務 |

**變數插值**: `{{prev}}` = 上一步輸出, `{{step.N}}` = 第 N 步輸出 (1-indexed)

**排程**: `/chain schedule <name> <HH:MM>` — 每日自動執行

**儲存**: `data/chains.json`, 用 `createJsonFileStore`

**限制**:
- 併發鎖：同一 chain 不能同時跑兩次
- `cmd` 步驟 60s timeout, chain 總上限 10 分鐘
- `bv` 步驟在有重度反爬的站（蝦皮、Cloudflare）可能被 CAPTCHA 擋

**bv 的定位**: 不是爬蟲，是「把別人的網站變 API」。你的站 → 自己開 API 比較實際。別人的站 → bv 自動化操作，等於瞬間幫對方開出 API。適合沒有 API 又沒有重度反爬的站。

### stats (`/stats`)
Git scanner across all projects + activity logger. Deduplicates worktrees by git common dir.
Subcommands: today, week, month, year, hours, projects, custom ranges (3d/2w/2025-02).
