/**
 * ClaudeBot Website — Bilingual i18n (繁體中文 / English)
 *
 * Usage:
 *   HTML: <span data-i18n="hero_tagline"></span>
 *         <input data-i18n-placeholder="plugins_search">
 *         <span data-i18n-html="some_key"></span>
 *   JS:   switchLang('en')  /  getCurrentLang()
 */

const translations = {
  zh: {
    // Nav
    nav_features: '功能',
    nav_directives: '指令系統',
    nav_plugins: '插件',
    nav_commands: '指令',
    nav_start: '開始使用',
    nav_docs: '文件',

    // Hero
    hero_tagline: '不只是 Claude 的接口。',
    hero_subtitle: '你手機上的指揮中心。',
    hero_desc: '一個 Telegram Bot 平台，整合 Claude Code CLI、插件系統、語音辨識、遠端配對、多專案管理。插件零 AI 成本運行。',
    hero_cta_start: '開始使用',
    hero_cta_github: 'GitHub',
    hero_stat_commands: '指令',
    hero_stat_plugins: '插件',
    hero_stat_backends: 'AI 後端',
    hero_stat_bots: '同時 Bot',

    // Features
    features_title: '核心功能',
    features_subtitle: '打造最強 Telegram AI 指揮中心',
    feat_stream_title: '即時串流',
    feat_stream_desc: '每秒更新回應狀態、工具名稱、執行耗時，掌握 AI 每一步動態。',
    feat_ai_title: '多 AI 後端',
    feat_ai_desc: '支援 Claude / Gemini / auto 模式，/model 一鍵切換，選擇最適合的 AI。',
    feat_remote_title: '遠端配對',
    feat_remote_desc: '/pair 連接遠端電腦，AI 透過 WebSocket + 10 個 MCP 工具讀寫遠端檔案。',
    feat_directive_title: 'AI 指令系統',
    feat_directive_desc: 'Claude 不只回覆 — 它執行。@cmd、@file、@confirm、@run 六大指令自動化一切。',
    feat_memory_title: '四層記憶',
    feat_memory_desc: '書籤、釘選、AI 記憶、Vault 索引 — 對話永不遺失，隨時召回任何上下文。',
    feat_worktree_title: 'Git Worktree 隔離',
    feat_worktree_desc: '多個 Bot 同時在同一專案開發，各自獨立分支，/deploy 自動合併到 main。',
    feat_project_title: '多專案管理',
    feat_project_desc: '每個專案獨立 Session，--resume 延續對話，跨專案無縫切換。',
    feat_queue_title: '佇列系統',
    feat_queue_desc: '序列執行 + 跨 Bot 檔案鎖，確保一次只有一個 CLI 進程運行。',
    feat_ui_title: '互動式 UI',
    feat_ui_desc: '確認按鈕、建議追問、選項偵測，讓 AI 互動不只是文字。',
    feat_voice_title: '語音辨識',
    feat_voice_desc: 'Sherpa-ONNX 本地語音辨識 + 2x 加速播放 + LLM 智慧修正。',
    feat_plugin_title: '插件系統',
    feat_plugin_desc: '19+ 插件、熱重載、零 AI 成本、Plugin Store 一鍵安裝。',
    feat_crossproject_title: '跨專案委派',
    feat_crossproject_desc: 'AI 偵測到其他專案需要改動時，@run 自動排隊執行，零手動切換。',

    // AI Directives
    directives_title: 'AI 指令系統',
    directives_subtitle: 'Claude 不只回覆 — 它採取行動',
    dir_cmd_desc: '執行任何 Bot 指令',
    dir_file_desc: '傳送檔案給用戶',
    dir_confirm_desc: '顯示 inline 選擇按鈕',
    dir_notify_desc: '獨立推送通知',
    dir_run_desc: '跨專案委派任務',
    dir_pipe_desc: '呼叫 CloudPipe API',
    directives_example_label: '用戶說「設個 5 分鐘提醒」',
    directives_example_reply: '好，5 分鐘後提醒你！',
    directives_example_note: '← Bot 攔截執行，用戶只看到確認文字',

    // 4-Layer Memory
    memory_title: '四層記憶系統',
    memory_subtitle: 'AI 聊天最大痛點 — 忘東忘西。ClaudeBot 用四層解決。',
    mem_bookmark_title: '書籤',
    mem_bookmark_desc: '快速存取程式碼片段、設定。per-project JSON 儲存。',
    mem_pin_title: '上下文釘選',
    mem_pin_desc: '每次對話自動注入。「我們用 Prisma，不是 Sequelize」。',
    mem_ai_title: 'AI 記憶',
    mem_ai_desc: '外部知識庫，跨 session 保持長期專案知識。',
    mem_vault_title: 'Vault 索引',
    mem_vault_desc: '所有訊息自動索引。/vault inject 搜尋過去對話，回注上下文。',

    // How it works
    how_title: '運作方式',
    how_subtitle: '從手機到程式碼，一條流水線',
    how_step1_title: 'Telegram',
    how_step1_desc: '文字或語音',
    how_step2_title: 'ClaudeBot',
    how_step2_desc: '佇列、路由、Session',
    how_step3_title: '插件（零成本）',
    how_step3_desc: '骰子、提醒、統計',
    how_step4_title: 'AI 後端',
    how_step4_desc: 'Claude / Gemini',
    how_step5_title: '專案檔案',
    how_step5_desc: '本地 codebase',
    how_step6_title: '遠端電腦',
    how_step6_desc: 'WebSocket + MCP',

    // Getting started
    start_title: '開始使用',
    start_subtitle: '一行指令就能啟動',
    start_oneliner_label: '推薦：一鍵安裝',
    start_or: '或手動安裝：',
    start_prereq: '需要：Node.js 20+、<a href="https://docs.anthropic.com/en/docs/claude-code" target="_blank" class="text-accent hover:underline">Claude CLI</a>（已登入）。選配：Gemini CLI、ffmpeg、Python 3.11+。',

    // Plugin catalog
    plugins_title: '插件目錄',
    plugins_subtitle: '從 Plugin Store 一鍵安裝，零 AI 成本運行',
    plugins_search: '搜尋插件...',
    plugins_loading: '從 GitHub 載入插件...',
    plugins_error: '無法載入遠端插件，顯示預設列表',
    plugins_author: '作者',

    // Commands
    commands_title: '指令參考',
    commands_subtitle: '50+ 內建指令，涵蓋專案管理到遠端操控',
    commands_search: '搜尋指令...',
    commands_all: '全部',
    commands_cat_project: '專案管理',
    commands_cat_ai: 'AI 控制',
    commands_cat_remote: '遠端',
    commands_cat_todo: '待辦靈感',
    commands_cat_bot: 'Bot 管理',
    commands_cat_store: 'Plugin Store',
    commands_col_command: '指令',
    commands_col_desc: '說明',
    commands_col_cat: '分類',

    // Command descriptions
    cmd_projects: '列出所有專案',
    cmd_select: '選擇工作專案',
    cmd_fav: '切換常用專案',
    cmd_status: '查看目前狀態',
    cmd_context: '上下文管理 (pin/list/clear)',
    cmd_deploy: '部署專案 (commit + merge + push)',
    cmd_sync: '同步所有 worktree',
    cmd_run: '跨專案執行指令',
    cmd_claudemd: '自動生成/更新 CLAUDE.md',
    cmd_model: '切換 AI 模型',
    cmd_new: '開啟新對話',
    cmd_cancel: '取消目前任務',
    cmd_chat: '通用對話模式（不含專案）',
    cmd_deep: '深度分析 (Opus + subagent)',
    cmd_parallel: '平行執行多個任務',
    cmd_asr: '語音辨識 (on/off)',
    cmd_ctx: '查看/管理上下文摘要',
    cmd_pair: '配對遠端電腦',
    cmd_unpair: '斷開遠端配對',
    cmd_grab: '從遠端下載檔案',
    cmd_rstatus: '查看遠端系統狀態',
    cmd_rexec: '在遠端執行指令',
    cmd_desktop: '列出遠端桌面檔案',
    cmd_ls: '列出遠端目錄',
    cmd_todo: '新增待辦事項',
    cmd_todos: '查看待辦列表',
    cmd_idea: '記錄靈感',
    cmd_ideas: '查看靈感列表',
    cmd_vault: '訊息索引/搜尋/注入/摘要',
    cmd_save: '儲存訊息 (書籤/釘選/AI記憶)',
    cmd_help: '查看所有指令',
    cmd_newbot: '產生新 Bot 設定',
    cmd_restart: '重啟 Bot',
    cmd_reload: '熱重載插件',
    cmd_stats: '生產力統計',
    cmd_cost: '查看 AI 花費面板',
    cmd_sysinfo: '查看系統資訊',
    cmd_store: '瀏覽插件商店',
    cmd_install: '安裝插件',
    cmd_uninstall: '移除插件',

    // No results
    commands_no_results: '找不到符合的指令',
    plugins_no_results: '找不到符合的插件',

    // Ecosystem
    eco_title: '開發者生態系',
    eco_subtitle: '從新機器到上線，一條龍',
    eco_devup: '新機器？一個指令重建整個工作環境。',
    eco_zerosetup: '任何 GitHub 專案，雙擊就能跑。零設定。',
    eco_claudebot: '從手機用 AI 寫程式碼、管理專案。',
    eco_cloudpipe: '自架 Vercel。自動部署、Telegram 控制、31+ MCP 工具。',
    eco_combo: 'ClaudeBot + CloudPipe = 從 Telegram 寫程式碼，CloudPipe 自動部署，不用打開筆電。',

    // Footer
    footer_desc: '你手機上的 AI 指揮中心。開源、可擴展、零成本插件。',
    footer_links: '連結',
    footer_resources: '資源',
    footer_docs: 'Claude Code 文檔',
    footer_plugin_store: 'Plugin Store',
    footer_guide: '使用指南',
    footer_ecosystem: '生態系',
    footer_license: '授權條款',
  },
  en: {
    // Nav
    nav_features: 'Features',
    nav_directives: 'Directives',
    nav_plugins: 'Plugins',
    nav_commands: 'Commands',
    nav_start: 'Get Started',
    nav_docs: 'Docs',

    // Hero
    hero_tagline: 'Not a pipe to Claude.',
    hero_subtitle: 'A command center on your phone.',
    hero_desc: 'A Telegram Bot platform integrating Claude Code CLI, plugin system, voice recognition, remote pairing, and multi-project management. Plugins run at zero AI cost.',
    hero_cta_start: 'Get Started',
    hero_cta_github: 'GitHub',
    hero_stat_commands: 'Commands',
    hero_stat_plugins: 'Plugins',
    hero_stat_backends: 'AI Backends',
    hero_stat_bots: 'Concurrent Bots',

    // Features
    features_title: 'Core Features',
    features_subtitle: 'Building the ultimate Telegram AI command center',
    feat_stream_title: 'Real-time Streaming',
    feat_stream_desc: 'Live response status, tool names, and execution time updates every second.',
    feat_ai_title: 'Multi-AI Backend',
    feat_ai_desc: 'Support Claude / Gemini / auto mode. Switch with /model in one tap.',
    feat_remote_title: 'Remote Pairing',
    feat_remote_desc: '/pair any remote machine. AI reads & writes files via WebSocket + 10 MCP tools.',
    feat_directive_title: 'AI Directive System',
    feat_directive_desc: 'Claude doesn\'t just reply — it takes action. @cmd, @file, @confirm, @run automate everything.',
    feat_memory_title: '4-Layer Memory',
    feat_memory_desc: 'Bookmarks, pins, AI memory, Vault indexing — never lose context, recall anything anytime.',
    feat_worktree_title: 'Git Worktree Isolation',
    feat_worktree_desc: 'Multiple bots work on the same project simultaneously on separate branches. /deploy auto-merges.',
    feat_project_title: 'Multi-Project',
    feat_project_desc: 'Independent sessions per project with --resume for continuous conversations.',
    feat_queue_title: 'Queue System',
    feat_queue_desc: 'Sequential execution + cross-bot file locks ensure single CLI process at a time.',
    feat_ui_title: 'Interactive UI',
    feat_ui_desc: 'Confirmation buttons, follow-up suggestions, choice detection — beyond plain text.',
    feat_voice_title: 'Voice ASR',
    feat_voice_desc: 'Sherpa-ONNX local voice recognition + 2x speed + LLM smart correction.',
    feat_plugin_title: 'Plugin System',
    feat_plugin_desc: '19+ plugins, hot-reload, zero AI cost, one-click install from Plugin Store.',
    feat_crossproject_title: 'Cross-Project Delegation',
    feat_crossproject_desc: 'AI detects when another project needs changes and auto-queues the task. Zero manual switching.',

    // AI Directives
    directives_title: 'AI Directive System',
    directives_subtitle: 'Claude doesn\'t just reply — it takes action',
    dir_cmd_desc: 'Execute any bot command',
    dir_file_desc: 'Send a file to the user',
    dir_confirm_desc: 'Show inline choice buttons',
    dir_notify_desc: 'Send a standalone notification',
    dir_run_desc: 'Delegate task to another project',
    dir_pipe_desc: 'Call CloudPipe APIs',
    directives_example_label: 'User says "set a 5 minute reminder"',
    directives_example_reply: 'Got it, reminding you in 5 minutes!',
    directives_example_note: '← Bot intercepts and executes, user only sees the confirmation',

    // 4-Layer Memory
    memory_title: '4-Layer Memory System',
    memory_subtitle: 'The biggest pain in AI chat — forgetting context. ClaudeBot solves it with four layers.',
    mem_bookmark_title: 'Bookmarks',
    mem_bookmark_desc: 'Quick recall of code snippets and configs. Per-project JSON storage.',
    mem_pin_title: 'Context Pins',
    mem_pin_desc: 'Auto-injected every prompt. "We use Prisma, not Sequelize."',
    mem_ai_title: 'AI Memory',
    mem_ai_desc: 'External knowledge base. Long-term project knowledge across sessions.',
    mem_vault_title: 'Vault Index',
    mem_vault_desc: 'All messages auto-indexed. /vault inject searches past conversations and re-injects context.',

    // How it works
    how_title: 'How It Works',
    how_subtitle: 'From phone to codebase, one pipeline',
    how_step1_title: 'Telegram',
    how_step1_desc: 'Text or voice',
    how_step2_title: 'ClaudeBot',
    how_step2_desc: 'Queue, routing, session',
    how_step3_title: 'Plugins (Zero Cost)',
    how_step3_desc: 'Dice, reminders, stats',
    how_step4_title: 'AI Backend',
    how_step4_desc: 'Claude / Gemini',
    how_step5_title: 'Project Files',
    how_step5_desc: 'Local codebase',
    how_step6_title: 'Remote Machine',
    how_step6_desc: 'WebSocket + MCP',

    // Getting started
    start_title: 'Get Started',
    start_subtitle: 'One command to launch',
    start_oneliner_label: 'Recommended: one-liner install',
    start_or: 'Or install manually:',
    start_prereq: 'Requires: Node.js 20+, <a href="https://docs.anthropic.com/en/docs/claude-code" target="_blank" class="text-accent hover:underline">Claude CLI</a> (logged in). Optional: Gemini CLI, ffmpeg, Python 3.11+.',

    // Plugin catalog
    plugins_title: 'Plugin Catalog',
    plugins_subtitle: 'One-click install from Plugin Store, zero AI cost',
    plugins_search: 'Search plugins...',
    plugins_loading: 'Loading plugins from GitHub...',
    plugins_error: 'Could not load remote plugins, showing default list',
    plugins_author: 'Author',

    // Commands
    commands_title: 'Command Reference',
    commands_subtitle: '50+ built-in commands covering project management to remote control',
    commands_search: 'Search commands...',
    commands_all: 'All',
    commands_cat_project: 'Project',
    commands_cat_ai: 'AI Control',
    commands_cat_remote: 'Remote',
    commands_cat_todo: 'Todo & Ideas',
    commands_cat_bot: 'Bot Mgmt',
    commands_cat_store: 'Plugin Store',
    commands_col_command: 'Command',
    commands_col_desc: 'Description',
    commands_col_cat: 'Category',

    // Command descriptions
    cmd_projects: 'List all projects',
    cmd_select: 'Select working project',
    cmd_fav: 'Switch favorite project',
    cmd_status: 'View current status',
    cmd_context: 'Context management (pin/list/clear)',
    cmd_deploy: 'Deploy project (commit + merge + push)',
    cmd_sync: 'Sync all worktrees',
    cmd_run: 'Cross-project command execution',
    cmd_claudemd: 'Auto-generate/update CLAUDE.md',
    cmd_model: 'Switch AI model',
    cmd_new: 'Start new conversation',
    cmd_cancel: 'Cancel current task',
    cmd_chat: 'General chat mode (no project)',
    cmd_deep: 'Deep analysis (Opus + subagent)',
    cmd_parallel: 'Execute multiple tasks in parallel',
    cmd_asr: 'Voice recognition (on/off)',
    cmd_ctx: 'View/manage context digest',
    cmd_pair: 'Pair a remote machine',
    cmd_unpair: 'Disconnect remote pairing',
    cmd_grab: 'Download file from remote',
    cmd_rstatus: 'View remote system status',
    cmd_rexec: 'Execute command on remote',
    cmd_desktop: 'List remote desktop files',
    cmd_ls: 'List remote directory',
    cmd_todo: 'Add todo item',
    cmd_todos: 'View todo list',
    cmd_idea: 'Record an idea',
    cmd_ideas: 'View ideas list',
    cmd_vault: 'Message index/search/inject/summary',
    cmd_save: 'Save message (bookmark/pin/AI memory)',
    cmd_help: 'View all commands',
    cmd_newbot: 'Generate new bot config',
    cmd_restart: 'Restart Bot',
    cmd_reload: 'Hot-reload plugins',
    cmd_stats: 'Productivity statistics',
    cmd_cost: 'View AI cost dashboard',
    cmd_sysinfo: 'View system info',
    cmd_store: 'Browse plugin store',
    cmd_install: 'Install plugin',
    cmd_uninstall: 'Uninstall plugin',

    // No results
    commands_no_results: 'No matching commands found',
    plugins_no_results: 'No matching plugins found',

    // Ecosystem
    eco_title: 'Developer Ecosystem',
    eco_subtitle: 'From new machine to production, end to end',
    eco_devup: 'New machine? One command rebuilds your entire workspace.',
    eco_zerosetup: 'Any GitHub project, double-click to run. Zero setup.',
    eco_claudebot: 'Write code from your phone with AI.',
    eco_cloudpipe: 'Self-hosted Vercel. Auto-deploy, Telegram control, 31+ MCP tools.',
    eco_combo: 'ClaudeBot + CloudPipe = write code from Telegram, CloudPipe auto-deploys. No laptop needed.',

    // Footer
    footer_desc: 'Your AI command center on mobile. Open source, extensible, zero-cost plugins.',
    footer_links: 'Links',
    footer_resources: 'Resources',
    footer_docs: 'Claude Code Docs',
    footer_plugin_store: 'Plugin Store',
    footer_guide: 'Guide',
    footer_ecosystem: 'Ecosystem',
    footer_license: 'License',
  }
}

const STORAGE_KEY = 'claudebot-lang'
const ACTIVE_CLASSES = ['bg-white', 'text-ink', 'shadow-sm']
const INACTIVE_CLASSES = ['text-slate-400']

let currentLang = 'zh'

function getCurrentLang() {
  return currentLang
}

function applyTranslations(lang) {
  const dict = translations[lang]
  if (!dict) return

  // data-i18n → textContent
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    const key = el.getAttribute('data-i18n')
    if (dict[key] !== undefined) {
      el.textContent = dict[key]
    }
  })

  // data-i18n-placeholder → placeholder attribute
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
    const key = el.getAttribute('data-i18n-placeholder')
    if (dict[key] !== undefined) {
      el.placeholder = dict[key]
    }
  })

  // data-i18n-html → innerHTML
  document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
    const key = el.getAttribute('data-i18n-html')
    if (dict[key] !== undefined) {
      el.innerHTML = dict[key]
    }
  })
}

function updateToggleButtons(lang) {
  document.querySelectorAll('[data-lang-toggle]').forEach(function (btn) {
    const btnLang = btn.getAttribute('data-lang-toggle')
    if (btnLang === lang) {
      INACTIVE_CLASSES.forEach(function (c) { btn.classList.remove(c) })
      ACTIVE_CLASSES.forEach(function (c) { btn.classList.add(c) })
    } else {
      ACTIVE_CLASSES.forEach(function (c) { btn.classList.remove(c) })
      INACTIVE_CLASSES.forEach(function (c) { btn.classList.add(c) })
    }
  })
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

function getURLLang() {
  try {
    var params = new URLSearchParams(window.location.search)
    var lang = params.get('lang')
    if (lang === 'en' || lang === 'zh') return lang
  } catch (_) {}
  return null
}

function switchLang(lang) {
  if (!translations[lang]) return
  currentLang = lang

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

// Initialize on DOM ready
// Priority: URL param > localStorage > default 'zh'
document.addEventListener('DOMContentLoaded', function () {
  var urlLang = getURLLang()
  var saved = null
  try {
    saved = localStorage.getItem(STORAGE_KEY)
  } catch (_) {}

  currentLang = urlLang || ((saved === 'en' || saved === 'zh') ? saved : 'zh')

  applyTranslations(currentLang)
  updateToggleButtons(currentLang)
  updateURL(currentLang)
  document.documentElement.setAttribute('lang', currentLang === 'zh' ? 'zh-Hant' : 'en')

  try {
    localStorage.setItem(STORAGE_KEY, currentLang)
  } catch (_) {}

  document.querySelectorAll('[data-lang-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchLang(btn.getAttribute('data-lang-toggle'))
    })
  })
})
