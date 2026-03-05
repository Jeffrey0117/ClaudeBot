<p align="center">
  <img src="claudebot-logo.png" alt="ClaudeBot" width="160" />
</p>

<h1 align="center">ClaudeBot</h1>

<p align="center">
  <strong>不是接 Claude 的管子，是你手機上的指揮中心。</strong>
</p>

<p align="center">
  繁體中文 | <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://jeffrey0117.github.io/ClaudeBot/">文件網站</a> ·
  <a href="https://jeffrey0117.github.io/ClaudeBot/guide.html">使用指南</a> ·
  <a href="https://github.com/Jeffrey0117/claudebot-plugins">Plugin Store</a>
</p>

---

發一則 Telegram 訊息，Claude 直接改你的 codebase。即時串流輸出、隨時切換 AI 模型、排 10 個任務然後去散步。全在手機上完成。

不需要 API key、不需要雲端中繼。ClaudeBot 直接呼叫你機器上的 CLI 工具 — 整條管線都是你的。

## 為什麼選 ClaudeBot？

大部分「Telegram + AI」專案都是薄薄的轉發器 — 貼個 prompt，拿個回覆。ClaudeBot 是一個**平台**：

- **你發訊息，AI 改你的程式碼** — 真實檔案、真實 git repo、完整專案上下文
- **即時串流** — 每秒更新工具呼叫、執行時間、進度狀態
- **多 AI 智慧路由** — Claude 做重活、Gemini 做輕活、auto-router 自動分流
- **佇列系統** — 連發多個請求，依序執行，跨 bot 檔案鎖互斥
- **Session 記憶** — 透過 `--resume` 每個專案獨立保持對話上下文，不會斷
- **插件零 AI 成本** — 截圖、骰子、計時器、系統資訊、網頁搜尋 — 即時、免費
- **一份程式碼跑多個 Bot** — 跑 5+ 個 bot，用 `/newbot` 從 Telegram 直接新增
- **語音寫程式** — 對著 Telegram 講話，本地 Sherpa-ONNX 辨識，AI 直接執行
- **遠端配對** — `/pair` 配對遠端電腦，AI 透過 WebSocket + MCP 直接讀寫遠端檔案
- **AI 指令系統** — Claude 自主觸發指令、傳檔案、用按鈕問你問題
- **四層記憶** — 書籤、釘選、AI 記憶、Vault 索引，跨 session 保持上下文
- **Git Worktree 隔離** — 多個 bot 同時在不同分支上開發同一個專案
- **跨專案委派** — AI 偵測到其他專案需要改動時自動排隊執行

## 與其他方案比較

| | ClaudeBot | tmux bridge | API wrapper |
|---|---|---|---|
| 輸出 | 即時串流 + 工具進度 | 完成後才回傳 | 不適用 |
| 併發 | 佇列 + 跨 bot 檔案鎖 | 單一請求 | 不適用 |
| 認證 | Chat ID + bcrypt + 速率限制 | 無 | API key |
| 多專案 | 每專案獨立 session，自動恢復 | 單一 session | 不適用 |
| 介面 | 按鈕、建議、語音 | 純文字 | Web 表單 |
| 擴充 | 插件系統 + Plugin Store | Shell 腳本 | YAML 設定 |
| 記憶 | 四層（書籤/釘選/AI 記憶/Vault） | 無 | 無狀態 |
| 遠端 | WebSocket 配對 + 10 個 MCP 工具 | 僅 SSH | 不適用 |

## 架構

```
Telegram ──> ClaudeBot ──> Claude / Gemini / Codex
  (你)          │              │
              插件           專案 ──> @run(其他專案)
          (零成本)            │
                          CloudPipe ──> 自動部署
```

## 功能

### AI 指令系統

Claude 不只是回覆 — 它**採取行動**。AI 可以在回應中嵌入指令，bot 攔截並執行：

| 指令 | 功能 | 範例 |
|------|------|------|
| `@cmd(/command)` | 執行任何 bot 指令 | `@cmd(/restart)`、`@cmd(/schedule bitcoin 09:00)` |
| `@file(path)` | 傳送檔案給使用者 | `@file(report.md)` |
| `@confirm(q\|a\|b)` | 顯示選擇按鈕 | `@confirm(用哪個資料庫？\|PostgreSQL\|SQLite)` |
| `@notify(msg)` | 發送獨立通知 | `@notify(Build 完成，0 errors)` |
| `@run(project)` | 委派任務到其他專案 | `@run(CloudPipe) 更新 API endpoint` |
| `@pipe(service.action)` | 呼叫 CloudPipe API | `@pipe(monitor.status)` |

你說「每天九點推播比特幣價格」，Claude 回覆確認的同時自動執行 `@cmd(/schedule bitcoin 09:00)`。

### 四層記憶系統

上下文是 AI 對話最難的問題。ClaudeBot 用四層互補架構解決：

| 層級 | 指令 | 持久性 | 用途 |
|------|------|--------|------|
| **書籤** | `/save` → 📌 | 每專案 JSON | 快速存取程式碼片段、設定 |
| **上下文釘選** | `/save` → 📎 | 每次 prompt 自動注入 | 「永遠記住：我們用 Prisma 不用 Sequelize」 |
| **AI 記憶** | `/save` → 🧠 | 外部知識庫 | 長期專案知識 |
| **Vault** | `/vault` | 訊息索引 | 搜尋/回溯任何過去對話 |

**Vault** 靜默索引每一則訊息。AI 失憶時，`/vault inject` 拉回相關歷史。`/vault summary` 生成今天對話摘要。

**Context Digest** — Claude 每次回覆自動生成結構化 `[CTX]` 摘要（狀態、摘要、待辦、下一步）。當你只回「好」或「OK」，bot 自動注入這段摘要，Claude 就知道你在聊什麼。

### 智慧 UI

ClaudeBot 把 Claude 的回覆變成互動式 Telegram 介面：

- **選項偵測** — 帶選擇提示的編號清單自動變成 inline 按鈕
- **是否偵測** — 回覆末尾的問題自動生成確認按鈕
- **後續建議** — 每次回覆後，AI 生成 1-3 個可行動的建議按鈕
- **平行任務偵測** — 偵測到你發了任務清單，建議用 `/parallel` 併行執行

### 多 Bot 與 Git Worktree

一份程式碼跑 5+ 個 bot 實例。每個 bot 有自己的 git worktree 分支：

```
ProjectName/           ← main 分支（正式版）
ProjectName--bot1/     ← bot1 的 worktree
ProjectName--bot2/     ← bot2 的 worktree
```

- `.env` 設定 `WORKTREE_BRANCH=bot1` → 自動建立隔離 worktree
- 佇列、鎖、session 都以 worktree 路徑為 key — 零衝突
- `/deploy` → 在分支 commit → merge 到 main → push

### 遠端配對

把任何電腦配對到你的 bot。AI 透過 WebSocket 操作遠端檔案系統：

```
Telegram → Bot (你的電腦) → WebSocket → Agent (遠端電腦)
                                          └── 10 個 MCP 工具：
                                              讀、寫、列目錄、搜尋、
                                              grep、執行、系統資訊、
                                              專案總覽、下載、上傳
```

- `/pair code@192.168.1.50:3100` — 連線
- `/grab /path/to/file` — 從遠端下載
- `/rstatus` — 檢查遠端系統狀態
- **文件推送** — 配對時傳任何檔案給 bot → 自動傳到遠端電腦

### 語音管線

```
Telegram 語音 → OGG → ffmpeg 16kHz WAV → Sherpa-ONNX (本地)
     → biaodian 標點 → 選配 Gemini 精修 (⚡)
```

- 完全離線 ASR — 基本轉錄不需要任何 API
- 有序訊息緩衝確保語音 + 文字按發送順序到達
- `/asr on/off` 切換每個使用者的語音辨識

### 有序訊息緩衝

訊息可能亂序到達 bot（網路延遲、語音轉錄延遲）。緩衝修正這個問題：

- 以 Telegram `message_id`（遞增）為 key，每個聊天獨立
- 語音條目初始為 `pending` — 阻止 flush 直到轉錄完成
- 1 秒文字計時器、30 秒過期清掃
- 切換專案時自動 flush

### 插件生態系

19+ 內建插件，全部**零 AI 成本**（不消耗 token）：

| 插件 | 指令 | 功能 |
|------|------|------|
| Browse | `/browse` | Chrome DevTools Protocol 瀏覽器自動化 |
| Calc | `/calc` | 數學運算、日期計算、單位換算 |
| Clip | `/save` `/recall` | 統一記憶路由（書籤/釘選/AI 記憶） |
| Cost | `/cost` `/usage` | 按模型和專案追蹤 API 花費 |
| Dice | `/dice` `/coin` | 隨機數字和擲硬幣 |
| GitHub | `/star` `/follow` | Star repo、追蹤用戶、搜尋 |
| Map | `/map` | 地點查詢 → Google Maps 連結 |
| MCP | `/mcp` | 連接 MCP server，列出並呼叫外部工具 |
| Mdfix | `/mdfix` | 修正 Telegram Markdown 渲染問題 |
| Remote | `/pair` `/grab` | 遠端電腦配對與檔案傳輸 |
| Reminder | `/remind` | 一次性計時器（`5m`、`14:30`） |
| Scheduler | `/schedule` | 每日定時任務（如每天 09:00 推播比特幣價格） |
| Search | `/search` | 透過 SearXNG 網頁搜尋 |
| Stats | `/stats` | 使用分析 — 訊息、模型、專案、時間序列 |
| Sysinfo | `/sysinfo` | CPU、記憶體、磁碟、網路資訊 |
| Task | `/task` | 每日任務規劃表（時間段、狀態指示） |
| Vault | `/vault` | 訊息索引、搜尋、上下文回溯、摘要 |
| Write | `/write` | 快速筆記寫入 |

**Plugin Store** — 從 Telegram 瀏覽和安裝社群插件：
```
/store          ← 瀏覽可用插件
/install name   ← 從 GitHub registry 安裝
/uninstall name ← 移除
/reload         ← 不重啟即時熱載入
```

### 生產力工具

- **待辦** (`/todo`、`/todos`) — 每專案任務清單，`/todos all` 跨專案檢視
- **靈感** (`/idea`、`/ideas`) — 標籤分類的靈感記錄，`#dev`、`#biz`、`#life` 自動圖示
- **任務規劃** (`/task`) — 每日時間表、狀態指示器（✅🔔⏰⬜）、自動通知
- **定時排程** (`/schedule`) — 每日固定時間推播
- **提醒** (`/remind`) — 一次性計時器，支援相對（`5m`）和絕對（`14:30`）時間

### 跨專案委派

Claude 偵測到任務跨多個專案時自動委派：

```
你：「更新 API 格式，然後讓 ClaudeBot 用新格式」
Claude：修好 ClaudeBot 的程式碼，然後：
  @run(CloudPipe) 更新 API endpoint 接受新格式
```

Bot 自動在目標專案排隊。不需手動切換。

### CloudPipe 整合

如果你有跑 [CloudPipe](https://github.com/Jeffrey0117/CloudPipe)，ClaudeBot 可以透過 `@pipe` 控制：

```
@pipe(monitor.status)         ← 檢查所有監控的 URL
@pipe(monitor.add, URL)       ← 新增健康檢查
@pipe(gateway.tools)          ← 列出所有跨專案 MCP 工具
@pipe(health)                 ← CloudPipe 是否在跑？
```

### 更多功能

- **Web 儀表板** — 即時 bot 監控、心跳追蹤、runner 狀態
- **自動 commit** — AI 完成工作後自動 timestamp git commit
- **`/deploy`** — 一個指令：commit → merge worktree 到 main → push
- **`/deep`** — 深度分析模式（Opus + subagent，最大推理能力）
- **`/parallel`** — 併行執行多個獨立任務
- **`/claudemd`** — 自動生成 `CLAUDE.md` 專案文件
- **`/ctx`** — 檢視 AI 的上下文摘要（它記得什麼）
- **Bot 簡介自動更新** — Telegram bot 描述隨專案和模型即時更新
- **圖片分析** — 傳照片，Claude 用 vision 分析
- **等待趣聞** — 長任務等待時顯示有趣小知識
- **智慧重啟** — AI 修改程式碼後自動重啟 bot（不需手動）

## 安全性

- **Chat ID + bcrypt** 雙重認證
- **速率限制**（per user）
- **`shell: false`** 所有 process spawn
- **zod 輸入驗證**
- **禁止指令保護** — 防止 AI 執行 `taskkill /IM node.exe`（會殺掉自己）
- **受保護檔案** — `.env`、`.sessions.json`、`.pairings.json` 不允許 AI 刪除
- **跨 bot 檔案鎖** — 防止同時寫入同一專案

## 快速開始

```bash
npx claudebot-app
```

一行搞定 — 自動下載、安裝依賴、跑設定精靈、啟動 bot。

> **前置需求：** Node.js 20+、[Claude CLI](https://docs.anthropic.com/en/docs/claude-code)（已登入）。
> 選裝：Gemini CLI、ffmpeg（語音）、Python 3.11+（標點修正）。

<details>
<summary>手動安裝</summary>

```bash
git clone https://github.com/Jeffrey0117/ClaudeBot.git
cd ClaudeBot
npm install
npm run setup    # 互動式引導 — 自動建立 .env
npm run dev
```

</details>

## 完整文件

安裝指南、插件開發、多 Bot 架構、語音辨識、指令大全：

**[jeffrey0117.github.io/ClaudeBot](https://jeffrey0117.github.io/ClaudeBot/)**

---

## 生態系

ClaudeBot 是一個開發者工具鏈的一部分，從新電腦到上線，每一步都零摩擦：

| 工具 | 做什麼 | Repo |
|------|--------|------|
| [**DevUp**](https://github.com/Jeffrey0117/DevUp) | 新電腦？一個指令重建你的整個工作環境 | `npx devup-cli` |
| [**ZeroSetup**](https://github.com/Jeffrey0117/ZeroSetup) | 任何 GitHub 專案，雙擊就跑 | `npx zerosetup` |
| **ClaudeBot** | 在手機上用 AI 寫程式、改程式碼 | *你在這裡* |
| [**CloudPipe**](https://github.com/Jeffrey0117/CloudPipe) | 自架 Vercel。Git push 自動部署，Telegram 管理，31+ MCP 工具 | `npm i -g @jeffrey0117/cloudpipe` |
| [**MemoryGuy**](https://github.com/Jeffrey0117/MemoryGuy) | 記憶體洩漏偵測、安全優化、port 管理 | Electron app |

**ClaudeBot + CloudPipe** = 你在 Telegram 寫程式，CloudPipe 自動部署，上線了通知你。從靈感到上線，不用打開筆電。

## Star History

<a href="https://www.star-history.com/?repos=Jeffrey0117%2FClaudeBot&type=Date&legend=top-left#gh-light-mode-only">
  <img src="https://api.star-history.com/svg?repos=Jeffrey0117/ClaudeBot&type=Date&legend=top-left" alt="Star History Chart" width="100%" />
</a>
<a href="https://www.star-history.com/?repos=Jeffrey0117%2FClaudeBot&type=Date&legend=top-left#gh-dark-mode-only">
  <img src="https://api.star-history.com/svg?repos=Jeffrey0117/ClaudeBot&type=Date&theme=dark&legend=top-left" alt="Star History Chart" width="100%" />
</a>

## 授權

MIT
