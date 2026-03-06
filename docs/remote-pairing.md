# Remote Pairing (遠端配對)

從手機 Telegram 操控另一台電腦上的檔案，AI 直接在遠端讀寫、搜尋、執行指令。

## 運作原理

```
手機 Telegram ──> ClaudeBot (本機)
                     │
                  WebSocket Relay
                     │
              Remote Agent (遠端電腦)
                     │
              MCP Tools (read/write/search/exec)
```

1. **本機** 跑 ClaudeBot launcher + relay server
2. **遠端電腦** 跑 `agent.ts`，透過 WebSocket 連回本機
3. Claude CLI 啟動時動態注入 remote MCP config
4. AI 收到 `[遠端配對模式]` prompt，自動使用 `remote_*` 工具操作遠端

## 快速開始

### 1. 本機設定

在你要啟用 remote 功能的 bot `.env` 檔加上：

```env
REMOTE_ENABLED=true
```

> 只有 `REMOTE_ENABLED=true` 的 bot 實例會注入 remote MCP。
> 其他 bot 完全不受影響（預設 `false`）。

### 2. 在 Telegram 輸入 `/pair`

Bot 會回覆配對碼和連線指令，例如：

```
🔑 配對碼: DO8-QJQ

👇 首次 — 複製貼到 terminal:
git clone https://github.com/Jeffrey0117/ClaudeBot.git && cd ClaudeBot && npm install && npx tsx src/remote/agent.ts ws://192.168.0.182:9877 DO8-QJQ

👇 已裝過 — 直接連:
git pull && npx tsx src/remote/agent.ts ws://192.168.0.182:9877 DO8-QJQ

💡 指定專案目錄加在最後面:
...DO8-QJQ C:\path\to\project
```

### 3. 在遠端電腦執行連線指令

配對碼 5 分鐘內有效。連上後 bot 會通知 `🔗 已配對`。

### 4. 開始使用

之後在 Telegram 發的訊息，AI 會透過 MCP 工具操作遠端電腦：

| MCP 工具 | 功能 |
|---------|------|
| `remote_read_file` | 讀取遠端檔案 |
| `remote_write_file` | 寫入遠端檔案 |
| `remote_list_directory` | 列出目錄 |
| `remote_search_files` | 搜尋檔案內容 |
| `remote_execute_command` | 執行 shell 指令 |

### 5. 斷開配對

```
/unpair
```

## 多 Bot 實例隔離

| 設定 | 行為 |
|------|------|
| `REMOTE_ENABLED=true` | 注入 remote prompt + MCP config |
| `REMOTE_ENABLED=false`（預設） | 完全忽略 remote 功能 |

建議只在**一個** bot 實例開啟（例如 bot5），避免多個 bot 搶用同一個配對。

配對狀態存在 `data/pairings.json`，以 `chatId + threadId` 為 key，所以不同 chat 之間天然隔離。

## 遠端專屬使用者 (Remote-Only)

讓其他人透過 Telegram 使用你的 Claude，但只能操作**他們自己的電腦**（擋掉本機指令）。

### 設定

`.env` 加上對方的 Telegram chat ID：

```env
REMOTE_CHAT_IDS=111111111,222222222
```

> 這些使用者只能使用白名單指令：`/start` `/login` `/help` `/status` `/cancel` `/new` `/pair` `/unpair` `/model` `/projects` `/select` `/chat`
> 其他所有指令會被擋掉。

### 遠端 /projects

遠端使用者可以用 `/projects` 列出他們 agent 底下的專案資料夾，點選後切換：

```
/projects  →  列出遠端子資料夾  →  點選切換
/chat      →  純聊天模式（不看檔案）
```

## 額度管理 (Allot Plugin)

多台遠端共用你的 Claude 訂閱，用 `allot` 插件管控配額，避免打爆 rate limit。

### 啟用

`.env` 的 `PLUGINS` 加上 `allot`：

```env
PLUGINS=screenshot,dice,allot
```

### 快速上手

```
/allot on          ← 啟用額度管控
/allot ratio 20    ← 每台 remote 固定佔 20%
```

就這樣。自適應模式會自己調整 rate 預算（遇到 429 自動降，連續正常自動升）。

### 運作原理

```
總預算 × 每台佔比% × (1 - 安全邊際%) = 每台遠端的配額
```

**每台 remote 的配額是固定的**，不會因為其他 remote 上下線而改變：

```
/allot ratio 20，rateBudget=10，margin=10%
→ 每台 = 10 × 20% × 90% = 1.8 → 1 turn/5min

1 台 remote → 遠端總佔 20%
3 台 remote → 遠端總佔 60%
5 台 remote → 遠端總佔 100% ⚠️
```

面板會顯示「總佔」百分比，超過 80% 時會出現 ⚠️ 警告。

**你自己（本機）永遠不限制。**

### 所有指令

| 指令 | 說明 |
|------|------|
| `/allot` | 打開管理面板 |
| `/allot on\|off` | 啟用/停用 |
| `/allot ratio <5-95>` | 設定遠端佔比 % |
| `/allot auto` | 切換自適應模式 |
| `/allot set <N>` | 手動設定 Rate 預算 (turns/5min) |
| `/allot weekly <N>` | 設定每週預算 |
| `/allot margin <0-50>` | 安全邊際 % |
| `/allot reset <id>` | 重置某台 remote 的用量 |
| `/allot history` | 查看歷史紀錄 |

### 面板按鈕

面板提供 inline 按鈕快速操作：啟用/停用、Ratio +10/-10、Rate +5/-5、Weekly +100/-100、歷史、重整。

### 自適應演算法

- **起步**: 10 turns/5min
- **每 5 分鐘**: 沒 429 → +2（上限 100）
- **碰到 429**: → -10（下限 5），clean 計數歸零
- **手動模式**: 不自動調整

### 安全設計

- 只有 `ADMIN_CHAT_ID` 能使用 `/allot`（遠端使用者看不到、動不了）
- Plugin 沒載入或停用 → 所有請求直接放行
- 預扣沒結算（例如錯誤）→ 自動釋放
- `allot.json` 所有 bot 實例共享（存在 main repo）

## 注意事項

- Relay server 只在 main bot 啟動（`isMainBot` 檢查）
- 配對碼 5 分鐘過期（未連線時），連線後不過期
- 遠端 agent 的 cwd 就是你指定的專案目錄（或 clone 的 ClaudeBot 目錄）
- AI 收到 `[遠端配對模式]` 時會優先使用 `remote_*` 工具，不會用本地的 Read/Write/Bash

## 相關檔案

| 檔案 | 說明 |
|------|------|
| `src/remote/pairing-store.ts` | 配對狀態管理（file-backed） |
| `src/remote/relay-server.ts` | WebSocket relay server |
| `src/remote/agent.ts` | 遠端 agent（跑在遠端電腦） |
| `src/remote/mcp-config-generator.ts` | 動態生成 MCP config |
| `src/mcp/remote-proxy-server.ts` | MCP proxy（Claude CLI ↔ relay） |
| `src/bot/commands/pair.ts` | `/pair` 和 `/unpair` 指令 |
| `src/claude/claude-runner.ts` | prompt + MCP 注入邏輯 |
