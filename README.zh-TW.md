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
