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
- **一份程式碼跑多個 Bot** — 跑 4+ 個 bot，用 `/newbot` 從 Telegram 直接新增
- **語音寫程式** — 對著 Telegram 講話，本地 Sherpa-ONNX 辨識，AI 直接執行
- **遠端配對** — `/pair` 配對遠端電腦，AI 透過 MCP 直接讀寫遠端檔案，每個 bot 實例獨立隔離

## 與其他方案比較

| | ClaudeBot | tmux bridge | API wrapper |
|---|---|---|---|
| 輸出 | 即時串流 + 工具進度 | 完成後才回傳 | 不適用 |
| 併發 | 佇列 + 跨 bot 檔案鎖 | 單一請求 | 不適用 |
| 認證 | Chat ID + bcrypt + 速率限制 | 無 | API key |
| 多專案 | 每專案獨立 session，自動恢復 | 單一 session | 不適用 |
| 介面 | 按鈕、建議、語音 | 純文字 | Web 表單 |
| 擴充 | 插件系統 + Plugin Store | Shell 腳本 | YAML 設定 |

## 架構

```
Telegram ──> ClaudeBot ──> Claude / Gemini / Codex
  (你)          │              │
              插件           專案
          (零成本)       (via @run)
```

## 快速開始

```bash
npx claudebot-app
```

一行搞定 — 自動下載、安裝依賴、跑設定精靈、啟動 bot。

> **前置需求：** Node.js 20+、[Claude CLI](https://docs.anthropic.com/en/docs/claude-code)（已登入）。
> 選裝：[Gemini CLI](https://github.com/google-gemini/gemini-cli)、ffmpeg（語音）、Python 3.11+（標點修正）。

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

<details>
<summary>Windows 安裝注意事項</summary>

**bcrypt 編譯問題**

bcrypt 需要 C++ 編譯工具。如果 `npm install` 失敗：

```powershell
npm install -g windows-build-tools
# 或安裝 Visual Studio Build Tools（勾選「C++ 建置工具」）
```

**.env 路徑格式**

反斜線或正斜線都可以：

```
PROJECTS_BASE_DIR=C:\Users\you\code
# 或
PROJECTS_BASE_DIR=C:/Users/you/code
```

**一鍵安裝**

```powershell
npx zerosetup    # 自動安裝 Node.js、ffmpeg、依賴
```

</details>

<details>
<summary>語音辨識設定（選裝）</summary>

語音功能需要三樣東西：

1. **ffmpeg** — 將 Telegram 語音訊息轉成 WAV
   - Windows: `winget install Gyan.FFmpeg` 或 `scoop install ffmpeg`
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`

2. **Python 3.11+** — 標點符號模組
   - 下載: https://www.python.org/downloads/

3. **Sherpa ASR** — 語音辨識引擎
   ```bash
   # Clone 到 ClaudeBot 旁邊（自動偵測）
   cd ..
   git clone https://github.com/Jeffrey0117/Sherpa_ASR.git
   ```

沒裝語音功能 bot 一樣正常運作 — 收到語音訊息會顯示安裝說明，不會 crash。

</details>

## 完整文件

安裝指南、插件開發、多 Bot 架構、語音辨識、指令大全：

**[jeffrey0117.github.io/ClaudeBot](https://jeffrey0117.github.io/ClaudeBot/)**

## 疑難排解

<details>
<summary>常見問題</summary>

**`npm install` 在 Windows 失敗（bcrypt/node-gyp）**
→ 安裝建置工具: `npm install -g windows-build-tools`
→ 或安裝 Visual Studio Build Tools（勾選 C++ 工作負載）

**語音訊息報錯**
→ 檢查: `ffmpeg --version`（必須在 PATH 中）
→ 檢查: `python --version`（建議 3.11+）
→ 檢查: `../Sherpa_ASR/` 存在於 ClaudeBot 旁邊

**Bot 啟動了但不回應**
→ 確認 `ALLOWED_CHAT_IDS` 與你的 Telegram user ID 一致
→ 先發 `/start`
→ 檢查 `.env` 中 `AUTO_AUTH=true`

**「Claude CLI not found」**
→ 安裝: `npm install -g @anthropic-ai/claude-code`
→ 然後執行 `claude` 登入

**Session/上下文消失**
→ 長對話後正常現象 — Claude CLI 有 context window 限制
→ 用 `/new` 開始新 session

</details>

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
