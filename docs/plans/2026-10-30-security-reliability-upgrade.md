# 2026-10-30 全面升級：資安 + 可靠性 + UX

三路稽核（架構 / 弱點 / 功能盤點）後的升級批次。基線：172 tests 綠、tsc 乾淨。

## A. 資安（critical/high）

1. **@cmd 守門**（queue-processor）— LLM 輸出的 `@cmd(...)` 原本無白名單直接執行（prompt injection → `/rpower shutdown` 等）。改為：危險指令清單命中時不執行，改發確認按鈕（`cmdrun:/cmdskip:`，5 分鐘 TTL），安全指令照舊。新模組 `src/bot/cmd-guard.ts`。
2. **callback 權限補洞**（middleware/auth）— remote-only / Electron 虛擬用戶原本可按任何 inline 按鈕。改為 callback prefix 白名單（project/ai/model/machine/choice/suggest/last）。
3. **restart callback 防禦**（commands/restart）— handleRestartCallback 加 isRemoteOnly 擋板（縱深防禦）。
4. **remote-ops 注入修補** — `/ropen` URL 驗證（僅 http/https、禁引號）、`/rkill` 程式名白名單字元、`/rpull` 目錄禁 shell metachar。
5. **exec-tools 黑名單強化** — 補 flag 順序變體（rm -r -f、del /s /q 任意順序、Remove-Item -Recurse -Force、rd /s、vssadmin/cipher/reg delete HKLM/diskpart/bcdedit）。
6. **uncaughtException 收斂**（index.ts）— 裸 `includes('Timeout')` 改成 Playwright 特定格式，不再吞掉無關致命錯誤。

## B. 可靠性

7. **windowsHide 補齊** — voice-handler ffmpeg ×2（每則語音閃黑窗）、jarvis spawn（+ error handler，原本 ENOENT 會炸掉整個 bot）、launcher npx tsc ×2、tunnel cloudflared、launch-electron。
8. **json-file-store 多程序安全** — tmp 檔名加 pid+random（原本 N 個 bot 搶同一個 .tmp）、cache 以 mtime 失效（原本永久快取，跨 bot 寫入互相看不到）。state.ts 同步修 tmp。
9. **draft-sender 429 處理** — 429 讀 retry_after 進入冷卻、節流改為時間下限 + 小差量延遲、錯誤不再全靜默。
10. **queue-processor 送訊息防護** — statusMsg 失敗不再丟掉使用者 prompt；markdown fallback 加 catch 不中斷後續 chunk。
11. **queue.ts floating promise** — processNext 兩處加 catch；releaseLock 包 try/catch。

## C. UX

12. **/cancel 清佇列** — 取消運行同時清空該專案佇列並回報筆數（原本取消後排隊任務照跑）。
13. **/help 全量分組** — 原本只列 17/70 指令，重寫為分組完整版。
14. **text-splitter code fence 感知** — 長回應切割不再切壞 ``` 區塊（自動閉合+重開）。

## D. 清理

15. 刪 repo 裡 path-join bug 產物（三個 `C:Usersjeffb...` 檔 + data.restart-all）。
16. 依賴 minor 升級（MCP SDK、undici、ws、tsx、knip、@types）。playwright/zod/electron 大版本不動。

## 不做（後續）

- README 重寫（落後 7 個月）— 另開一輪
- zod 4 / vitest 5 / electron 45 major 升級
- 161 處 `.catch(() => {})` 全面盤點
- queue-processor (840 行) 拆分重構
