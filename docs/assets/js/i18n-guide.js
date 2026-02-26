/**
 * ClaudeBot Guide Page — Bilingual i18n (繁體中文 / English)
 *
 * Standalone i18n for the guide page. Does NOT depend on the main i18n.js.
 * Shares the same localStorage key ('claudebot-lang') and URL param (?lang=en).
 *
 * Usage:
 *   HTML: <span data-i18n="ch1_title"></span>
 *         <input data-i18n-placeholder="some_key">
 *         <span data-i18n-html="ch1_what_items"></span>
 *   JS:   switchLang('en')  /  getCurrentLang()
 */

const guideTranslations = {
  zh: {
    // ── Sidebar / Navigation ──
    guide_title: '使用指南',
    guide_back: '返回首頁',
    sidebar_getting_started: '入門',
    sidebar_core: '核心機制',
    sidebar_features: '功能特色',
    sidebar_advanced: '進階主題',
    sidebar_reference: '參考',

    // ── Chapter 1 — Overview ──
    ch1_title: '總覽',
    ch1_subtitle: 'ClaudeBot 是什麼？',
    ch1_intro: 'ClaudeBot 不是 Claude 的轉發器。它是一個建立在 Telegram 上的平台，讓你從手機指揮 AI 操控程式碼、管理專案、執行自動化任務。',
    ch1_what_title: '它能做什麼？',
    ch1_what_items:
      '<li>從手機送出程式碼修改指令，AI 直接改你的 codebase</li>' +
      '<li>多 AI 後端切換（Claude、Gemini）</li>' +
      '<li>插件零成本運行（骰子、計算機、提醒不需 AI）</li>' +
      '<li>語音辨識：講話就能寫程式</li>' +
      '<li>佇列系統：多人多 Bot 安全共用</li>' +
      '<li>Session 記憶：對話不會斷</li>',
    ch1_arch_title: '架構概覽',
    ch1_stack_title: '技術棧',
    ch1_stack_desc: 'Telegraf v4（Telegram Bot 框架）+ TypeScript（嚴格模式）+ Claude CLI / Gemini CLI + zod（驗證）+ bcrypt（認證）',
    ch1_who_title: '適合誰？',
    ch1_who_desc: '有自己 server 的開發者、想用手機操控程式碼的工程師、需要一個可擴充 Telegram Bot 平台的團隊。',
    ch1_what_1: '從手機送出程式碼修改指令，AI 直接改你的 codebase',
    ch1_what_2: '多 AI 後端切換（Claude、Gemini）',
    ch1_what_3: '插件零成本運行（骰子、計算機、提醒不需 AI）',
    ch1_what_4: '語音辨識：講話就能寫程式',
    ch1_what_5: '佇列系統：多人多 Bot 安全共用',
    ch1_what_6: 'Session 記憶：對話不會斷',
    ch1_tip: 'ClaudeBot 的插件完全不使用 AI API，所以骰子、計算機、提醒等功能的使用成本為零。',

    // ── Chapter 2 — Quick Start ──
    ch2_title: '快速開始',
    ch2_subtitle: '五分鐘上手',
    ch2_prereq_title: '環境需求',
    ch2_prereq_list:
      '<li>Node.js 20 以上</li>' +
      '<li>Claude CLI（已登入）</li>' +
      '<li>Git</li>' +
      '<li>Telegram Bot Token（從 @BotFather 取得）</li>',
    ch2_clone_title: '步驟一：Clone 與安裝',
    ch2_env_title: '步驟二：設定環境變數',
    ch2_env_desc: '複製 .env.example 為 .env，填入必要設定：',
    ch2_launch_title: '步驟三：啟動',
    ch2_login_title: '步驟四：登入',
    ch2_login_desc: '在 Telegram 找到你的 Bot，發送 /start，輸入密碼登入。',
    ch2_first_title: '步驟五：第一個請求',
    ch2_first_desc: '用 /projects 選擇專案，然後直接發送文字給 AI。',
    ch2_prereq_claude: 'Claude CLI（已登入）',
    ch2_prereq_token: 'Telegram Bot Token（從 @BotFather 取得）',
    ch2_note: '確保 Claude CLI 已安裝並登入（執行 claude --version 驗證）。',

    // ── Chapter 3 — Multi-AI ──
    ch3_title: '多 AI 後端',
    ch3_subtitle: 'Claude、Gemini，自由切換',
    ch3_intro: 'ClaudeBot 支援多個 AI 後端，你可以根據任務需求選擇最合適的模型。',
    ch3_backends_title: '支援的後端',
    ch3_claude_desc: 'Claude CLI（Sonnet / Opus）— 最強程式碼能力，適合複雜重構',
    ch3_gemini_desc: 'Gemini CLI（Flash / Pro）— 快速回應，適合輕量任務',
    ch3_switch_title: '切換模型',
    ch3_switch_desc: '使用 /model 指令，會顯示 inline 按鈕讓你選擇。',
    ch3_router_title: 'Auto Router',
    ch3_router_desc: '設定 auto 模式時，ClaudeBot 會根據訊息複雜度自動分流：Tier 1（簡單問答）→ Gemini Flash、Tier 2（一般任務）→ Gemini Pro、Tier 3（程式碼任務）→ Claude Sonnet。',
    ch3_backend_col: '後端',
    ch3_models_col: '模型',
    ch3_use_col: '適用場景',
    ch3_auto_models: '自動選擇',
    ch3_auto_desc: '根據複雜度自動分流',
    ch3_tier_type: '類型',
    ch3_tier_route: '路由',
    ch3_tier1: '簡單問答',
    ch3_tier2: '一般任務',
    ch3_tier3: '程式碼任務',

    // ── Chapter 4 — Queue System ──
    ch4_title: '佇列系統',
    ch4_subtitle: '序列執行，安全可靠',
    ch4_intro: 'Claude CLI 一次只能運行一個進程。ClaudeBot 的佇列系統確保所有請求依序處理，不會互相干擾。',
    ch4_how_title: '運作方式',
    ch4_how_desc: '每個專案有獨立佇列。當 AI 正在執行時，新的訊息會自動排隊。佇列支援 prompt merging：等待中的多條訊息會合併為一個請求。',
    ch4_lock_title: '跨 Bot 檔案鎖',
    ch4_lock_desc: '多個 Bot 共用同一個專案時，.claudebot.lock 檔案確保只有一個 Bot 能執行 AI 操作。鎖會在 5 分鐘後自動過期。',
    ch4_merge_title: 'Prompt Merging',
    ch4_merge_desc: '在佇列等待期間發送的多條訊息會被合併為單一請求，減少 API 呼叫次數，節省時間。',
    ch4_msg1: '訊息 1',
    ch4_queue_label: '佇列',
    ch4_merged: '合併請求',
    ch4_tip: '如果你在 AI 執行中連續發送多條訊息，它們會被合併為一個請求送出，你不需要等上一個完成。',

    // ── Chapter 5 — Session & Memory ──
    ch5_title: 'Session 與記憶',
    ch5_subtitle: '對話延續，不怕忘記',
    ch5_intro: 'ClaudeBot 使用 Claude CLI 的 --resume 機制保持對話上下文。每個 Bot 實例、每個專案都有獨立的 Session。',
    ch5_session_title: 'Session ID',
    ch5_session_desc: 'Session ID 儲存在 .sessions.json，key 格式為 ${BOT_ID}:${projectPath}。BOT_ID 是 bot token 的最後 6 碼，確保多 Bot 不會互相覆蓋。',
    ch5_expire_title: '自動過期',
    ch5_expire_desc: 'Session 在 30 分鐘沒有活動後自動過期，下次對話會開啟新 session。使用 /new 可以手動開啟新對話。',
    ch5_context_title: 'Context Preservation',
    ch5_context_desc: '短回覆（15 字以內）或肯定回覆（好、OK、可以...）會自動注入前次 AI 回應作為參考，防止 context 壓縮後的「失憶」。',
    ch5_pin_title: '/context 指令',
    ch5_pin_desc: '使用 /context 可以 pin/unpin 額外檔案到對話中，或查看/清除目前的上下文。',
    ch5_note: '當你回覆「好」或「OK」時，ClaudeBot 會自動帶上前次 AI 回應，確保 AI 知道你在同意什麼。',

    // ── Chapter 6 — Plugin System ──
    ch6_title: '插件系統',
    ch6_subtitle: '零 AI 成本，無限擴展',
    ch6_intro: 'ClaudeBot 的插件系統讓你用簡單的 TypeScript 檔案擴展功能。插件不經過 AI，直接執行，零成本。',
    ch6_interface_title: 'Plugin 介面',
    ch6_interface_desc: '每個插件匯出一個 Plugin 物件，包含 name、description、commands。',
    ch6_write_title: '寫一個插件',
    ch6_write_desc: '在 src/plugins/&lt;name&gt;/index.ts 建立檔案，匯出 Plugin 物件。',
    ch6_reload_title: '熱重載',
    ch6_reload_desc: '使用 /reload 指令可以不重啟 Bot 就更新插件程式碼。',
    ch6_hooks_title: 'Output Hook & Message Hook',
    ch6_hooks_desc: 'Output Hook 攔截 AI 回應做後處理（如 mdfix 修正 Markdown 格式）。Message Hook 攔截用戶訊息做前處理。',
    ch6_store_title: 'Plugin Store',
    ch6_store_desc: '使用 /store 瀏覽可用插件，/install 安裝，/uninstall 移除。插件從 GitHub 上的 claudebot-plugins 倉庫下載。',
    ch6_tip: '插件完全不經過 AI API，所以使用插件指令不會消耗任何 AI 費用。',

    // ── Chapter 7 — Voice ASR ──
    ch7_title: '語音辨識',
    ch7_subtitle: '說話就能寫程式',
    ch7_intro: 'ClaudeBot 整合 Sherpa-ONNX 本地語音辨識，不需要雲端 API，保護隱私。',
    ch7_flow_title: '辨識流程',
    ch7_flow_desc: 'Telegram .oga 語音 → ffmpeg 轉換 → 16kHz WAV → Sherpa-ONNX 辨識 → 文字',
    ch7_llm_title: 'LLM 智慧修正',
    ch7_llm_desc: '辨識完成後，使用 Gemini 修正語音辨識的錯字和語句，提高準確度。',
    ch7_hotword_title: 'Hotword 注入',
    ch7_hotword_desc: '專案名稱會自動加入辨識詞庫，提高專有名詞的辨識率。',
    ch7_toggle_title: '開關設定',
    ch7_toggle_desc: '使用 /asr 指令開啟或關閉語音辨識功能。',
    ch7_text: '文字',
    ch7_note: '需要安裝 ffmpeg 和 Sherpa-ONNX 模型檔案。首次啟用時 Bot 會自動下載模型。',

    // ── Chapter 8 — Interactive UI ──
    ch8_title: '互動式 UI',
    ch8_subtitle: '不只是文字對話',
    ch8_intro: 'ClaudeBot 自動偵測 AI 回應中的互動元素，轉換為 Telegram 原生按鈕，提升操作體驗。',
    ch8_choice_title: 'Choice Detector',
    ch8_choice_desc: '當 AI 回覆包含數字列表和選擇提示（哪個？要選哪個？）時，自動生成 inline 按鈕。',
    ch8_confirm_title: '確認按鈕',
    ch8_confirm_desc: 'AI 回覆「要繼續嗎？」等確認問句時，自動顯示 \u2713 和 \u2717 按鈕。',
    ch8_followup_title: 'Follow-up 建議',
    ch8_followup_desc: 'AI 回答後自動推薦相關追問，點擊即可繼續對話。',
    ch8_steer_title: 'Steer 模式',
    ch8_steer_desc: '以 ! 開頭的訊息會取消當前 AI 任務並立即發送新指令，用於緊急切換。',
    ch8_example_label: 'AI 回覆範例',
    ch8_warning: 'Choice Detector 會過濾技術描述中的數字列表（如 API 回應碼），避免假陽性。如果按鈕沒有出現，表示 AI 的回覆不包含選擇提示。',

    // ── Chapter 9 — Multi-Bot ──
    ch9_title: '多 Bot 架構',
    ch9_subtitle: '不同用途，獨立運行',
    ch9_intro: 'ClaudeBot 支援同時運行多個 Bot 實例，各自擁有獨立的 token、插件設定和 session。',
    ch9_why_title: '為什麼多 Bot？',
    ch9_why_desc: '不同用途分開管理：開發 Bot 用 Claude，生活 Bot 用 Gemini，團隊 Bot 共享專案。',
    ch9_config_title: '設定方式',
    ch9_config_desc: '在專案根目錄建立 .env.bot2、.env.bot3... 等檔案，每個檔案設定不同的 BOT_TOKEN。Launcher 會自動偵測並啟動所有 Bot。',
    ch9_launcher_title: 'Launcher 進程管理',
    ch9_launcher_desc: 'Launcher 包含 watchdog 監控、crash loop 防護（連續 crash 5 次後等待 60 秒）、自動重啟。',
    ch9_newbot_title: '/newbot 指令',
    ch9_newbot_desc: '使用 /newbot 可以快速產生新的 .env 檔案模板。',
    ch9_sleep_title: 'Sleep Prevention',
    ch9_sleep_desc: '設定 PREVENT_SLEEP=true 可防止系統進入睡眠，確保 Bot 24/7 運行。',

    // ── Chapter 10 — Auto-commit ──
    ch10_title: '自動提交',
    ch10_subtitle: 'AI 改動，自動版控',
    ch10_intro: '啟用 AUTO_COMMIT=true 後，每次 AI 完成程式碼修改，ClaudeBot 會自動執行 git add、commit 和 push。',
    ch10_enable_title: '啟用方式',
    ch10_enable_desc: '在 .env 中設定 AUTO_COMMIT=true。',
    ch10_flow_title: '執行流程',
    ch10_flow_desc: 'AI 完成 → 偵測改動檔案 → git add . → git commit → git push → 通知用戶（改動檔案數 + push 狀態）。',
    ch10_safety_title: '安全機制',
    ch10_safety_desc: '自動遵守 .gitignore、過濾可能包含 secrets 的檔案（.env、credentials 等）。',
    ch10_step1: 'AI 完成',
    ch10_step2: '偵測改動',
    ch10_step5: '通知',
    ch10_warning: 'Auto-commit 會自動 push 到遠端。請確保你的分支策略允許自動推送。',

    // ── Chapter 11 — Web Dashboard ──
    ch11_title: 'Web Dashboard',
    ch11_subtitle: '視覺化即時監控',
    ch11_intro: 'ClaudeBot 內建 Express + WebSocket 的 Web Dashboard，提供即時 Bot 狀態監控。',
    ch11_heartbeat_title: 'Heartbeat',
    ch11_heartbeat_desc: '每 2 秒更新 Bot 狀態，包含目前專案、佇列長度、執行中的任務。',
    ch11_commander_title: 'Command Reader',
    ch11_commander_desc: '從 Dashboard 直接送指令給 Bot，不需要打開 Telegram。',
    ch11_tracker_title: 'Runner Tracker',
    ch11_tracker_desc: '追蹤目前正在執行的 AI 任務，顯示執行時間和狀態。',
    ch11_tip: 'Dashboard 使用 WebSocket 即時更新，無需手動重新整理頁面。',

    // ── Chapter 12 — Command Reference ──
    ch12_title: '指令大全',
    ch12_subtitle: '完整指令表',
    ch12_intro: '以下是 ClaudeBot 所有內建指令的完整參考。',
    ch12_cat_project: '專案管理',
    ch12_cat_ai: 'AI 控制',
    ch12_cat_todo: '待辦 & 靈感',
    ch12_cat_bot: 'Bot 管理',
    ch12_cat_store: 'Plugin Store',
    ch12_advanced_title: '進階用法',
    ch12_run_desc: '/run &lt;command&gt; — 在選定專案目錄執行 shell 指令。支援任何命令，結果直接回傳 Telegram。',
    ch12_chat_desc: '/chat 或 @chat — 輕量聊天模式，不載入專案上下文，適合快速問答。',
    ch12_fav_desc: '/fav — 書籤功能，快速切換常用專案。',
    ch12_col_cmd: '指令',
    ch12_col_desc: '說明',
    ch12_col_example: '範例',
    ch12_projects: '列出所有可用專案',
    ch12_select: '選擇工作專案',
    ch12_fav: '切換常用專案書籤',
    ch12_status: '查看目前狀態（專案、模型、佇列）',
    ch12_context: '管理對話上下文（pin / unpin / clear）',
    ch12_run: '在專案目錄執行 shell 指令',
    ch12_model: '切換 AI 模型（Claude / Gemini / Auto）',
    ch12_new: '開啟新對話（清除 session）',
    ch12_cancel: '取消目前正在執行的 AI 任務',
    ch12_chat: '輕量聊天模式（不載入專案上下文）',
    ch12_asr: '開關語音辨識',
    ch12_todo: '新增待辦事項',
    ch12_todos: '查看待辦列表',
    ch12_idea: '記錄靈感',
    ch12_ideas: '查看靈感列表',
    ch12_help: '查看所有可用指令',
    ch12_newbot: '產生新 Bot 的 .env 設定模板',
    ch12_reload: '熱重載插件（不重啟 Bot）',
    ch12_store: '瀏覽 Plugin Store',
    ch12_install: '安裝插件',
    ch12_uninstall: '移除插件',
    guide_back_footer: '返回首頁',

    // ── Common UI ──
    tip_label: '提示',
    note_label: '注意',
    warning_label: '警告',
    source_label: '源碼',
    toc_title: '本頁目錄',
    nav_prev: '上一篇',
    nav_next: '下一篇',
  },

  en: {
    // ── Sidebar / Navigation ──
    guide_title: 'Guide',
    guide_back: 'Back to Home',
    sidebar_getting_started: 'Getting Started',
    sidebar_core: 'Core Systems',
    sidebar_features: 'Features',
    sidebar_advanced: 'Advanced',
    sidebar_reference: 'Reference',

    // ── Chapter 1 — Overview ──
    ch1_title: 'Overview',
    ch1_subtitle: 'What is ClaudeBot?',
    ch1_intro: 'ClaudeBot is not a relay to Claude. It\'s a platform built on Telegram that lets you command AI from your phone to manipulate code, manage projects, and run automated tasks.',
    ch1_what_title: 'What can it do?',
    ch1_what_items:
      '<li>Send code modification commands from your phone, AI directly edits your codebase</li>' +
      '<li>Switch between multiple AI backends (Claude, Gemini)</li>' +
      '<li>Plugins run at zero cost (dice, calculator, reminders don\'t need AI)</li>' +
      '<li>Voice recognition: speak to code</li>' +
      '<li>Queue system: safe multi-user, multi-bot sharing</li>' +
      '<li>Session memory: conversations don\'t break</li>',
    ch1_arch_title: 'Architecture Overview',
    ch1_stack_title: 'Tech Stack',
    ch1_stack_desc: 'Telegraf v4 (Telegram Bot framework) + TypeScript (strict mode) + Claude CLI / Gemini CLI + zod (validation) + bcrypt (authentication)',
    ch1_who_title: 'Who is it for?',
    ch1_who_desc: 'Developers with their own server, engineers who want to control code from their phone, teams needing an extensible Telegram Bot platform.',
    ch1_what_1: 'Send code modification commands from your phone, AI directly edits your codebase',
    ch1_what_2: 'Switch between multiple AI backends (Claude, Gemini)',
    ch1_what_3: 'Plugins run at zero cost (dice, calculator, reminders don\'t need AI)',
    ch1_what_4: 'Voice recognition: speak to code',
    ch1_what_5: 'Queue system: safe multi-user, multi-bot sharing',
    ch1_what_6: 'Session memory: conversations don\'t break',
    ch1_tip: 'ClaudeBot plugins don\'t use the AI API at all, so dice, calculator, reminders and similar features cost absolutely nothing to use.',

    // ── Chapter 2 — Quick Start ──
    ch2_title: 'Quick Start',
    ch2_subtitle: 'Up and running in 5 minutes',
    ch2_prereq_title: 'Prerequisites',
    ch2_prereq_list:
      '<li>Node.js 20+</li>' +
      '<li>Claude CLI (logged in)</li>' +
      '<li>Git</li>' +
      '<li>Telegram Bot Token (from @BotFather)</li>',
    ch2_clone_title: 'Step 1: Clone & Install',
    ch2_env_title: 'Step 2: Configure Environment',
    ch2_env_desc: 'Copy .env.example to .env and fill in required settings:',
    ch2_launch_title: 'Step 3: Launch',
    ch2_login_title: 'Step 4: Login',
    ch2_login_desc: 'Find your bot on Telegram, send /start, and enter your password to login.',
    ch2_first_title: 'Step 5: First Request',
    ch2_first_desc: 'Use /projects to select a project, then send text directly to the AI.',
    ch2_prereq_claude: 'Claude CLI (logged in)',
    ch2_prereq_token: 'Telegram Bot Token (from @BotFather)',
    ch2_note: 'Make sure Claude CLI is installed and logged in (run claude --version to verify).',

    // ── Chapter 3 — Multi-AI ──
    ch3_title: 'Multi-AI Backend',
    ch3_subtitle: 'Claude, Gemini \u2014 switch freely',
    ch3_intro: 'ClaudeBot supports multiple AI backends. Choose the best model for your task.',
    ch3_backends_title: 'Supported Backends',
    ch3_claude_desc: 'Claude CLI (Sonnet / Opus) \u2014 Best coding ability, ideal for complex refactoring',
    ch3_gemini_desc: 'Gemini CLI (Flash / Pro) \u2014 Fast responses, ideal for lightweight tasks',
    ch3_switch_title: 'Switching Models',
    ch3_switch_desc: 'Use the /model command to see inline buttons for selection.',
    ch3_router_title: 'Auto Router',
    ch3_router_desc: 'In auto mode, ClaudeBot routes based on message complexity: Tier 1 (simple Q&A) \u2192 Gemini Flash, Tier 2 (general tasks) \u2192 Gemini Pro, Tier 3 (coding tasks) \u2192 Claude Sonnet.',
    ch3_backend_col: 'Backend',
    ch3_models_col: 'Models',
    ch3_use_col: 'Use Case',
    ch3_auto_models: 'Auto-select',
    ch3_auto_desc: 'Routes based on complexity',
    ch3_tier_type: 'Type',
    ch3_tier_route: 'Route',
    ch3_tier1: 'Simple Q&A',
    ch3_tier2: 'General tasks',
    ch3_tier3: 'Coding tasks',

    // ── Chapter 4 — Queue System ──
    ch4_title: 'Queue System',
    ch4_subtitle: 'Sequential execution, safe and reliable',
    ch4_intro: 'Claude CLI can only run one process at a time. ClaudeBot\'s queue system ensures all requests are processed sequentially without interference.',
    ch4_how_title: 'How It Works',
    ch4_how_desc: 'Each project has its own queue. When the AI is running, new messages are automatically queued. The queue supports prompt merging: multiple pending messages are combined into a single request.',
    ch4_lock_title: 'Cross-Bot File Lock',
    ch4_lock_desc: 'When multiple bots share a project, the .claudebot.lock file ensures only one bot can run AI operations. Locks auto-expire after 5 minutes.',
    ch4_merge_title: 'Prompt Merging',
    ch4_merge_desc: 'Multiple messages sent during queue wait are merged into a single request, reducing API calls and saving time.',
    ch4_msg1: 'Message 1',
    ch4_queue_label: 'Queue',
    ch4_merged: 'Merged Request',
    ch4_tip: 'If you send multiple messages while AI is running, they\'ll be merged into one request \u2014 no need to wait for the previous one to finish.',

    // ── Chapter 5 — Session & Memory ──
    ch5_title: 'Session & Memory',
    ch5_subtitle: 'Continuous conversations, never forget',
    ch5_intro: 'ClaudeBot uses Claude CLI\'s --resume mechanism to maintain conversation context. Each bot instance and project has independent sessions.',
    ch5_session_title: 'Session ID',
    ch5_session_desc: 'Session IDs are stored in .sessions.json with key format ${BOT_ID}:${projectPath}. BOT_ID is the last 6 characters of the bot token, ensuring multi-bot isolation.',
    ch5_expire_title: 'Auto Expiration',
    ch5_expire_desc: 'Sessions auto-expire after 30 minutes of inactivity. The next conversation starts a new session. Use /new to manually start a new conversation.',
    ch5_context_title: 'Context Preservation',
    ch5_context_desc: 'Short replies (under 15 chars) or affirmative replies (\u597D, OK, \u53EF\u4EE5...) automatically inject the previous AI response as reference, preventing "amnesia" after context compression.',
    ch5_pin_title: '/context Command',
    ch5_pin_desc: 'Use /context to pin/unpin additional files to the conversation, or view/clear current context.',
    ch5_note: 'When you reply with "\u597D" or "OK", ClaudeBot automatically includes the previous AI response, ensuring the AI knows what you\'re agreeing to.',

    // ── Chapter 6 — Plugin System ──
    ch6_title: 'Plugin System',
    ch6_subtitle: 'Zero AI cost, unlimited extensions',
    ch6_intro: 'ClaudeBot\'s plugin system lets you extend functionality with simple TypeScript files. Plugins bypass AI, execute directly, at zero cost.',
    ch6_interface_title: 'Plugin Interface',
    ch6_interface_desc: 'Each plugin exports a Plugin object containing name, description, and commands.',
    ch6_write_title: 'Writing a Plugin',
    ch6_write_desc: 'Create a file at src/plugins/&lt;name&gt;/index.ts and export a Plugin object.',
    ch6_reload_title: 'Hot Reload',
    ch6_reload_desc: 'Use /reload to update plugin code without restarting the bot.',
    ch6_hooks_title: 'Output Hook & Message Hook',
    ch6_hooks_desc: 'Output Hook intercepts AI responses for post-processing (e.g., mdfix fixes Markdown formatting). Message Hook intercepts user messages for pre-processing.',
    ch6_store_title: 'Plugin Store',
    ch6_store_desc: 'Use /store to browse available plugins, /install to install, /uninstall to remove. Plugins are downloaded from the claudebot-plugins repo on GitHub.',
    ch6_tip: 'Plugins don\'t go through the AI API at all, so using plugin commands costs zero AI fees.',

    // ── Chapter 7 — Voice ASR ──
    ch7_title: 'Voice Recognition',
    ch7_subtitle: 'Speak to code',
    ch7_intro: 'ClaudeBot integrates Sherpa-ONNX local voice recognition \u2014 no cloud API needed, protecting privacy.',
    ch7_flow_title: 'Recognition Flow',
    ch7_flow_desc: 'Telegram .oga voice \u2192 ffmpeg conversion \u2192 16kHz WAV \u2192 Sherpa-ONNX recognition \u2192 text',
    ch7_llm_title: 'LLM Smart Correction',
    ch7_llm_desc: 'After recognition, Gemini corrects speech recognition errors and improves accuracy.',
    ch7_hotword_title: 'Hotword Injection',
    ch7_hotword_desc: 'Project names are automatically added to the recognition vocabulary, improving recognition of proper nouns.',
    ch7_toggle_title: 'Toggle Settings',
    ch7_toggle_desc: 'Use /asr to enable or disable voice recognition.',
    ch7_text: 'Text',
    ch7_note: 'Requires ffmpeg and Sherpa-ONNX model files. The bot will automatically download models on first activation.',

    // ── Chapter 8 — Interactive UI ──
    ch8_title: 'Interactive UI',
    ch8_subtitle: 'Beyond text conversations',
    ch8_intro: 'ClaudeBot automatically detects interactive elements in AI responses and converts them to native Telegram buttons for a better experience.',
    ch8_choice_title: 'Choice Detector',
    ch8_choice_desc: 'When AI replies contain numbered lists with selection prompts (which one? pick one?), inline buttons are automatically generated.',
    ch8_confirm_title: 'Confirmation Buttons',
    ch8_confirm_desc: 'When AI asks confirmation questions like "Continue?", \u2713 and \u2717 buttons are automatically shown.',
    ch8_followup_title: 'Follow-up Suggestions',
    ch8_followup_desc: 'After AI answers, related follow-up questions are suggested. Click to continue the conversation.',
    ch8_steer_title: 'Steer Mode',
    ch8_steer_desc: 'Messages starting with ! cancel the current AI task and immediately send a new command, useful for urgent switches.',
    ch8_example_label: 'AI Reply Example',
    ch8_warning: 'Choice Detector filters out numbered lists in technical descriptions (like API response codes) to avoid false positives. If buttons don\'t appear, the AI\'s reply doesn\'t contain a selection prompt.',

    // ── Chapter 9 — Multi-Bot ──
    ch9_title: 'Multi-Bot Architecture',
    ch9_subtitle: 'Different purposes, independent operation',
    ch9_intro: 'ClaudeBot supports running multiple bot instances simultaneously, each with independent tokens, plugin settings, and sessions.',
    ch9_why_title: 'Why Multi-Bot?',
    ch9_why_desc: 'Separate management for different purposes: dev bot uses Claude, life bot uses Gemini, team bot shares projects.',
    ch9_config_title: 'Configuration',
    ch9_config_desc: 'Create .env.bot2, .env.bot3... files in the project root, each with a different BOT_TOKEN. The launcher auto-detects and starts all bots.',
    ch9_launcher_title: 'Launcher Process Management',
    ch9_launcher_desc: 'Launcher includes watchdog monitoring, crash loop protection (waits 60s after 5 consecutive crashes), and auto-restart.',
    ch9_newbot_title: '/newbot Command',
    ch9_newbot_desc: 'Use /newbot to quickly generate a new .env file template.',
    ch9_sleep_title: 'Sleep Prevention',
    ch9_sleep_desc: 'Set PREVENT_SLEEP=true to prevent system sleep, ensuring 24/7 bot operation.',

    // ── Chapter 10 — Auto-commit ──
    ch10_title: 'Auto-commit',
    ch10_subtitle: 'AI changes, automatic version control',
    ch10_intro: 'With AUTO_COMMIT=true enabled, after each AI code modification, ClaudeBot automatically runs git add, commit, and push.',
    ch10_enable_title: 'How to Enable',
    ch10_enable_desc: 'Set AUTO_COMMIT=true in .env.',
    ch10_flow_title: 'Execution Flow',
    ch10_flow_desc: 'AI completes \u2192 detect changed files \u2192 git add . \u2192 git commit \u2192 git push \u2192 notify user (file count + push status).',
    ch10_safety_title: 'Safety Measures',
    ch10_safety_desc: 'Automatically respects .gitignore, filters files that may contain secrets (.env, credentials, etc.).',
    ch10_step1: 'AI Complete',
    ch10_step2: 'Detect Changes',
    ch10_step5: 'Notify',
    ch10_warning: 'Auto-commit will automatically push to remote. Make sure your branch strategy allows automatic pushes.',

    // ── Chapter 11 — Web Dashboard ──
    ch11_title: 'Web Dashboard',
    ch11_subtitle: 'Visual real-time monitoring',
    ch11_intro: 'ClaudeBot includes a built-in Express + WebSocket Web Dashboard for real-time bot status monitoring.',
    ch11_heartbeat_title: 'Heartbeat',
    ch11_heartbeat_desc: 'Updates bot status every 2 seconds, including current project, queue length, and running tasks.',
    ch11_commander_title: 'Command Reader',
    ch11_commander_desc: 'Send commands to the bot directly from the Dashboard without opening Telegram.',
    ch11_tracker_title: 'Runner Tracker',
    ch11_tracker_desc: 'Track currently running AI tasks, showing execution time and status.',
    ch11_tip: 'The Dashboard uses WebSocket for real-time updates \u2014 no need to manually refresh the page.',

    // ── Chapter 12 — Command Reference ──
    ch12_title: 'Command Reference',
    ch12_subtitle: 'Complete command table',
    ch12_intro: 'Here is the complete reference for all ClaudeBot built-in commands.',
    ch12_cat_project: 'Project Management',
    ch12_cat_ai: 'AI Control',
    ch12_cat_todo: 'Todo & Ideas',
    ch12_cat_bot: 'Bot Management',
    ch12_cat_store: 'Plugin Store',
    ch12_advanced_title: 'Advanced Usage',
    ch12_run_desc: '/run &lt;command&gt; \u2014 Execute shell commands in the selected project directory. Supports any command, results sent back to Telegram.',
    ch12_chat_desc: '/chat or @chat \u2014 Lightweight chat mode without project context, ideal for quick Q&A.',
    ch12_fav_desc: '/fav \u2014 Bookmark feature for quickly switching between favorite projects.',
    ch12_col_cmd: 'Command',
    ch12_col_desc: 'Description',
    ch12_col_example: 'Example',
    ch12_projects: 'List all available projects',
    ch12_select: 'Select working project',
    ch12_fav: 'Toggle favorite project bookmark',
    ch12_status: 'View current status (project, model, queue)',
    ch12_context: 'Manage conversation context (pin / unpin / clear)',
    ch12_run: 'Execute shell command in project directory',
    ch12_model: 'Switch AI model (Claude / Gemini / Auto)',
    ch12_new: 'Start new conversation (clear session)',
    ch12_cancel: 'Cancel currently running AI task',
    ch12_chat: 'Lightweight chat mode (no project context)',
    ch12_asr: 'Toggle voice recognition',
    ch12_todo: 'Add todo item',
    ch12_todos: 'View todo list',
    ch12_idea: 'Record an idea',
    ch12_ideas: 'View ideas list',
    ch12_help: 'View all available commands',
    ch12_newbot: 'Generate new bot .env config template',
    ch12_reload: 'Hot-reload plugins (no restart)',
    ch12_store: 'Browse Plugin Store',
    ch12_install: 'Install plugin',
    ch12_uninstall: 'Uninstall plugin',
    guide_back_footer: 'Back to Home',

    // ── Common UI ──
    tip_label: 'Tip',
    note_label: 'Note',
    warning_label: 'Warning',
    source_label: 'Source',
    toc_title: 'On This Page',
    nav_prev: 'Previous',
    nav_next: 'Next',
  },
}

/* ── i18n Engine (standalone — does NOT depend on main i18n.js) ── */

;(function () {
  var STORAGE_KEY = 'claudebot-lang'
  var ACTIVE_CLASSES = ['bg-white', 'text-ink', 'shadow-sm']
  var INACTIVE_CLASSES = ['text-slate-400']

  var _currentLang = 'zh'

  /* ── Helpers ── */

  function getURLLang() {
    try {
      var params = new URLSearchParams(window.location.search)
      var lang = params.get('lang')
      if (lang === 'en' || lang === 'zh') return lang
    } catch (_) {}
    return null
  }

  function updateURL(lang) {
    var url = new URL(window.location)
    if (lang === 'zh') {
      url.searchParams.delete('lang')
    } else {
      url.searchParams.set('lang', lang)
    }
    window.history.replaceState({}, '', url)
  }

  function applyTranslations(lang) {
    var dict = guideTranslations[lang]
    if (!dict) return

    // data-i18n -> textContent
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n')
      if (dict[key] !== undefined) {
        el.textContent = dict[key]
      }
    })

    // data-i18n-placeholder -> placeholder attribute
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-placeholder')
      if (dict[key] !== undefined) {
        el.placeholder = dict[key]
      }
    })

    // data-i18n-html -> innerHTML
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-html')
      if (dict[key] !== undefined) {
        el.innerHTML = dict[key]
      }
    })
  }

  function updateToggleButtons(lang) {
    document.querySelectorAll('[data-lang-toggle]').forEach(function (btn) {
      var btnLang = btn.getAttribute('data-lang-toggle')
      if (btnLang === lang) {
        INACTIVE_CLASSES.forEach(function (c) { btn.classList.remove(c) })
        ACTIVE_CLASSES.forEach(function (c) { btn.classList.add(c) })
      } else {
        ACTIVE_CLASSES.forEach(function (c) { btn.classList.remove(c) })
        INACTIVE_CLASSES.forEach(function (c) { btn.classList.add(c) })
      }
    })
  }

  /* ── Public API ── */

  function getCurrentLang() {
    return _currentLang
  }

  function switchLang(lang) {
    if (!guideTranslations[lang]) return
    _currentLang = lang

    try {
      localStorage.setItem(STORAGE_KEY, lang)
    } catch (_) {}

    updateURL(lang)

    document.documentElement.style.transition = 'opacity 0.15s ease'
    document.documentElement.style.opacity = '0.6'

    requestAnimationFrame(function () {
      applyTranslations(lang)
      updateToggleButtons(lang)
      document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-Hant' : 'en')

      requestAnimationFrame(function () {
        document.documentElement.style.opacity = '1'
      })
    })
  }

  // Expose globally
  window.getCurrentLang = getCurrentLang
  window.switchLang = switchLang

  /* ── Init on DOM ready ── */

  document.addEventListener('DOMContentLoaded', function () {
    var urlLang = getURLLang()
    var saved = null
    try {
      saved = localStorage.getItem(STORAGE_KEY)
    } catch (_) {}

    _currentLang = urlLang || ((saved === 'en' || saved === 'zh') ? saved : 'zh')

    applyTranslations(_currentLang)
    updateToggleButtons(_currentLang)
    updateURL(_currentLang)
    document.documentElement.setAttribute('lang', _currentLang === 'zh' ? 'zh-Hant' : 'en')

    try {
      localStorage.setItem(STORAGE_KEY, _currentLang)
    } catch (_) {}

    // Wire up toggle buttons
    document.querySelectorAll('[data-lang-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.switchLang(btn.getAttribute('data-lang-toggle'))
      })
    })
  })
})()
