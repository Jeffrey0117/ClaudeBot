# Screenshot Feature Design

## Date: 2026-02-15

## Problem

用手機透過 Telegram 操控 Claude Code 開發時，無法看到電腦上的畫面（網頁 UI、Electron app 等），也無法直觀確認 Claude 產出的截圖或圖片結果。

## Solution

兩個功能：

### 功能 1：`/screenshot <URL>` 指令

- 使用者在 Telegram 下 `/screenshot <URL>` 指令
- Bot 使用 Playwright 無頭瀏覽器截取網頁
- 截圖存為暫存 PNG → `replyWithPhoto()` 傳回 Telegram → 清理暫存檔
- 支援可選 `full` 參數截全頁：`/screenshot <URL> full`
- 預設 viewport: 1280x720

### 功能 2：Claude 回應自動偵測圖片路徑

- 在 `queue-processor.ts` 的 `onResult` 回調中掃描 `resultText`
- 正則匹配絕對路徑 + 圖片副檔名（`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`）
- 找到的每個路徑，驗證檔案存在後用 `sendPhoto` 傳回 Telegram
- 圖片傳完後照常傳文字回應

## New Files

| File | Purpose |
|------|---------|
| `src/bot/commands/screenshot.ts` | `/screenshot` 指令 handler |
| `src/utils/image-detector.ts` | 從文字中偵測圖片路徑的工具函式 |

## Modified Files

| File | Change |
|------|--------|
| `src/bot/bot.ts` | 註冊 `/screenshot` 指令 |
| `src/bot/queue-processor.ts` | `onResult` 中加圖片偵測 + `sendPhoto` |
| `src/bot/commands/help.ts` | 加 `/screenshot` 說明 |
| `package.json` | 新增 `playwright` 依賴 |

## Dependencies

- `playwright` — 截圖引擎（需安裝 chromium browser）

## Flow

```
/screenshot https://localhost:3000
  → Playwright launch → 截圖 → PNG → replyWithPhoto → cleanup

Claude 回應 "截圖已存到 C:\app\screenshot.png"
  → 掃描到路徑 → 檢查檔案存在 → sendPhoto → 正常送文字
```

## Decision: Approach A

選擇「/screenshot 指令 + result 文字掃描圖片路徑」方案。
不做目錄監控（方案 B），未來有需要再加。
