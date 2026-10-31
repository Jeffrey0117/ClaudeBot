# 2026-10-31 失憶修復 + 訊息效率

Jeff 問：「傳訊息會有效率嗎？會很容易忘記專案嗎？」深入這兩點。

## 診斷

**效率**：turn 本身 p50 52s（模型，改不了）。可改的是 enqueue 前的固定 1 秒收集窗 —
單句訊息也空等 1000ms。

**失憶（真 bug）**：CTX 注入只在 `prompt.length<=15 || (<=80 && affirmative)`
（claude-runner.ts:331）觸發。TTL 過期（4h idle）後開新 session 走的不是 rotation
路徑，正常長度訊息→零 CTX 注入→Claude 全失憶且無提示。state.ts（選了哪個專案）是
持久化的，不會忘；真正會忘的是 session 層的對話記憶。

## 修法

### A. 失憶（核心）

1. **claude-runner 注入條件擴大**：`sessionId === null` 時（新 session，不論首次/TTL
   過期/重啟後 disk 也沒）一律嘗試注入 CTX 摘要，不再限訊息長度。

2. **消除雙重注入**：queue-processor 的 rotation 路徑原本自己 prepend injection 到
   runPrompt，然後傳 sessionId=null 給 runner → runner 若也注入就雙重。改為 rotation
   只負責 rotate + 通知，注入統一交給 runner（sessionId=null 自然觸發）。

3. **digest 加 savedAt 時間戳**：注入時標注「這是 N 小時前的摘要，可能是不同任務」，
   讓 Claude 自行判斷相關性（避免注入很舊的 context 誤導）。向後相容：舊資料無
   savedAt 就不標年齡。

4. **TTL 過期告知使用者**：session 因閒置過期而重開時，發一則「🧠 距上次對話超過 4
   小時，已開新 session（用摘要接續）」。靠 runner 的 onFreshSession 回呼，queue-
   processor 發訊息。

5. **session-store 一致性**：expired 時也清 promptCounts（原本漏清）。

### B. 能見度

6. **/status 強化**：顯示 session 年齡、累積輪數、token 佔用 %（距 rotation 多遠）、
   接近上限時提示 /new。新增 `getSessionInfo()`。

### C. 效率

7. **單句快送**：ordered-message-buffer 若 buffer 僅 1 條 ready text、無 voice
   pending，用 400ms 短 debounce；多條或有語音才等滿 1000ms 合併窗。

## 測試

- session-store：getSessionInfo 年齡/輪數/佔用；expired 清 promptCounts
- context-digest：savedAt 標注、向後相容
- buffer 單句快送邏輯（若可純函式化）

## 不做

- naive substring 專案切換（另議，需 UX 決策）
- turn 本身加速（模型層）
