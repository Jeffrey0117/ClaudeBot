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
    nav_plugins: '插件',
    nav_commands: '指令',
    nav_start: '開始使用',

    // Hero
    hero_tagline: '不只是 Claude 的接口。',
    hero_subtitle: '你手機上的指揮中心。',
    hero_desc: '一個 Telegram Bot 平台，整合 Claude Code CLI、插件系統、語音辨識、多專案管理。插件零 AI 成本運行。',
    hero_cta_start: '開始使用',
    hero_cta_github: 'GitHub',
    hero_stat_commands: '指令',
    hero_stat_plugins: '插件',
    hero_stat_backends: 'AI 後端',
    hero_stat_projects: '專案',

    // Features
    features_title: '核心功能',
    features_subtitle: '打造最強 Telegram AI 指揮中心',
    feat_stream_title: '即時串流',
    feat_stream_desc: '每秒更新回應狀態、工具名稱、執行耗時，掌握 AI 每一步動態。',
    feat_ai_title: '多 AI 後端',
    feat_ai_desc: '支援 Claude / Gemini / auto 模式，/model 一鍵切換，選擇最適合的 AI。',
    feat_project_title: '多專案管理',
    feat_project_desc: '每個專案獨立 Session，--resume 延續對話，跨專案無縫切換。',
    feat_queue_title: '佇列系統',
    feat_queue_desc: '序列執行 + 跨 Bot 檔案鎖，確保一次只有一個 CLI 進程運行。',
    feat_ui_title: '互動式 UI',
    feat_ui_desc: '確認按鈕、建議追問、選項偵測，讓 AI 互動不只是文字。',
    feat_voice_title: '語音辨識',
    feat_voice_desc: 'Sherpa-ONNX 本地語音辨識 + 2x 加速播放 + LLM 智慧修正。',
    feat_plugin_title: '插件系統',
    feat_plugin_desc: '熱重載、零 AI 成本、Plugin Store 一鍵安裝，輕鬆擴展功能。',
    feat_commit_title: '自動提交',
    feat_commit_desc: 'AI 改動後自動 git commit + push，程式碼版本控制全自動。',
    feat_dashboard_title: 'Web 儀表板',
    feat_dashboard_desc: 'React 面板 + WebSocket 即時監控，視覺化掌握 Bot 狀態。',

    // How it works
    how_title: '運作方式',
    how_subtitle: '簡單三層架構，強大無限可能',
    how_step1_title: 'Telegram 訊息',
    how_step1_desc: '在手機上傳送文字或語音',
    how_step2_title: 'ClaudeBot 處理',
    how_step2_desc: '佇列管理、插件路由、Session 追蹤',
    how_step3_title: '插件（零成本）',
    how_step3_desc: '骰子、計算機、提醒等不需 AI',
    how_step4_title: 'AI 後端',
    how_step4_desc: 'Claude / Gemini 處理複雜請求',
    how_step5_title: '專案檔案',
    how_step5_desc: '直接操作你的程式碼庫',

    // Plugin catalog
    plugins_title: '插件目錄',
    plugins_subtitle: '從 Plugin Store 一鍵安裝，零 AI 成本運行',
    plugins_search: '搜尋插件...',
    plugins_loading: '從 GitHub 載入插件...',
    plugins_error: '無法載入遠端插件，顯示預設列表',
    plugins_author: '作者',

    // Commands
    commands_title: '指令參考',
    commands_subtitle: '27+ 內建指令，涵蓋專案管理到 Bot 控制',
    commands_search: '搜尋指令...',
    commands_all: '全部',
    commands_cat_project: '專案管理',
    commands_cat_ai: 'AI 控制',
    commands_cat_todo: '待辦靈感',
    commands_cat_bot: 'Bot 管理',
    commands_cat_store: 'Plugin Store',
    commands_col_command: '指令',
    commands_col_desc: '說明',
    commands_col_cat: '分類',

    // Getting started
    start_title: '開始使用',
    start_subtitle: '三步驟，從零到指揮中心',
    start_step1: '步驟一：複製專案',
    start_step2: '步驟二：設定環境',
    start_step3: '步驟三：啟動',
    start_env_desc: '在 .env 中填入以下設定：',
    start_env_token: '從 @BotFather 取得',
    start_env_password: '你的登入密碼',
    start_env_projects: '專案路徑（逗號分隔）',

    // Command descriptions
    cmd_projects: '列出所有專案',
    cmd_select: '選擇工作專案',
    cmd_fav: '切換常用專案',
    cmd_status: '查看目前狀態',
    cmd_context: '注入額外上下文檔案',
    cmd_run: '執行 shell 指令',
    cmd_model: '切換 AI 模型',
    cmd_new: '開啟新對話',
    cmd_cancel: '取消目前任務',
    cmd_chat: '輕量聊天模式（不含專案）',
    cmd_asr: '語音辨識設定',
    cmd_todo: '新增待辦事項',
    cmd_todos: '查看待辦列表',
    cmd_idea: '記錄靈感',
    cmd_ideas: '查看靈感列表',
    cmd_help: '查看所有指令',
    cmd_newbot: '產生新 Bot 設定',
    cmd_reload: '熱重載插件',
    cmd_store: '瀏覽插件商店',
    cmd_install: '安裝插件',
    cmd_uninstall: '移除插件',

    // No results
    commands_no_results: '找不到符合的指令',
    plugins_no_results: '找不到符合的插件',

    // Footer
    footer_desc: '你手機上的 AI 指揮中心。開源、可擴展、零成本插件。',
    footer_links: '連結',
    footer_resources: '資源',
    footer_docs: 'Claude Code 文檔',
    footer_plugin_store: 'Plugin Store',
    footer_license: '授權條款',
  },
  en: {
    // Nav
    nav_features: 'Features',
    nav_plugins: 'Plugins',
    nav_commands: 'Commands',
    nav_start: 'Get Started',

    // Hero
    hero_tagline: 'Not a pipe to Claude.',
    hero_subtitle: 'A command center on your phone.',
    hero_desc: 'A Telegram Bot platform integrating Claude Code CLI, plugin system, voice recognition, and multi-project management. Plugins run at zero AI cost.',
    hero_cta_start: 'Get Started',
    hero_cta_github: 'GitHub',
    hero_stat_commands: 'Commands',
    hero_stat_plugins: 'Plugins',
    hero_stat_backends: 'AI Backends',
    hero_stat_projects: 'Projects',

    // Features
    features_title: 'Core Features',
    features_subtitle: 'Building the ultimate Telegram AI command center',
    feat_stream_title: 'Real-time Streaming',
    feat_stream_desc: 'Live response status, tool names, and execution time updates every second.',
    feat_ai_title: 'Multi-AI Backend',
    feat_ai_desc: 'Support Claude / Gemini / auto mode. Switch with /model in one tap.',
    feat_project_title: 'Multi-Project',
    feat_project_desc: 'Independent sessions per project with --resume for continuous conversations.',
    feat_queue_title: 'Queue System',
    feat_queue_desc: 'Sequential execution + cross-bot file locks ensure single CLI process at a time.',
    feat_ui_title: 'Interactive UI',
    feat_ui_desc: 'Confirmation buttons, follow-up suggestions, choice detection — beyond plain text.',
    feat_voice_title: 'Voice ASR',
    feat_voice_desc: 'Sherpa-ONNX local voice recognition + 2x speed + LLM smart correction.',
    feat_plugin_title: 'Plugin System',
    feat_plugin_desc: 'Hot-reload, zero AI cost, one-click install from Plugin Store.',
    feat_commit_title: 'Auto-commit',
    feat_commit_desc: 'Automatic git commit + push after AI changes. Fully automated version control.',
    feat_dashboard_title: 'Web Dashboard',
    feat_dashboard_desc: 'React panel + WebSocket real-time monitoring for visual bot status.',

    // How it works
    how_title: 'How It Works',
    how_subtitle: 'Simple three-layer architecture, unlimited possibilities',
    how_step1_title: 'Telegram Message',
    how_step1_desc: 'Send text or voice on your phone',
    how_step2_title: 'ClaudeBot Engine',
    how_step2_desc: 'Queue management, plugin routing, session tracking',
    how_step3_title: 'Plugins (Zero Cost)',
    how_step3_desc: 'Dice, calculator, reminders — no AI needed',
    how_step4_title: 'AI Backend',
    how_step4_desc: 'Claude / Gemini for complex requests',
    how_step5_title: 'Project Files',
    how_step5_desc: 'Directly operate on your codebase',

    // Plugin catalog
    plugins_title: 'Plugin Catalog',
    plugins_subtitle: 'One-click install from Plugin Store, zero AI cost',
    plugins_search: 'Search plugins...',
    plugins_loading: 'Loading plugins from GitHub...',
    plugins_error: 'Could not load remote plugins, showing default list',
    plugins_author: 'Author',

    // Commands
    commands_title: 'Command Reference',
    commands_subtitle: '27+ built-in commands covering project management to bot control',
    commands_search: 'Search commands...',
    commands_all: 'All',
    commands_cat_project: 'Project',
    commands_cat_ai: 'AI Control',
    commands_cat_todo: 'Todo & Ideas',
    commands_cat_bot: 'Bot Mgmt',
    commands_cat_store: 'Plugin Store',
    commands_col_command: 'Command',
    commands_col_desc: 'Description',
    commands_col_cat: 'Category',

    // Getting started
    start_title: 'Get Started',
    start_subtitle: 'Three steps from zero to command center',
    start_step1: 'Step 1: Clone',
    start_step2: 'Step 2: Configure',
    start_step3: 'Step 3: Launch',
    start_env_desc: 'Fill in the following in .env:',
    start_env_token: 'Get from @BotFather',
    start_env_password: 'Your login password',
    start_env_projects: 'Project paths (comma-separated)',

    // Command descriptions
    cmd_projects: 'List all projects',
    cmd_select: 'Select working project',
    cmd_fav: 'Switch favorite project',
    cmd_status: 'View current status',
    cmd_context: 'Inject additional context files',
    cmd_run: 'Execute shell command',
    cmd_model: 'Switch AI model',
    cmd_new: 'Start new conversation',
    cmd_cancel: 'Cancel current task',
    cmd_chat: 'Lightweight chat mode (no project)',
    cmd_asr: 'Voice recognition settings',
    cmd_todo: 'Add todo item',
    cmd_todos: 'View todo list',
    cmd_idea: 'Record an idea',
    cmd_ideas: 'View ideas list',
    cmd_help: 'View all commands',
    cmd_newbot: 'Generate new bot config',
    cmd_reload: 'Hot-reload plugins',
    cmd_store: 'Browse plugin store',
    cmd_install: 'Install plugin',
    cmd_uninstall: 'Uninstall plugin',

    // No results
    commands_no_results: 'No matching commands found',
    plugins_no_results: 'No matching plugins found',

    // Footer
    footer_desc: 'Your AI command center on mobile. Open source, extensible, zero-cost plugins.',
    footer_links: 'Links',
    footer_resources: 'Resources',
    footer_docs: 'Claude Code Docs',
    footer_plugin_store: 'Plugin Store',
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
