export type Locale = 'zh' | 'en'

const translations = {
  // Header
  'header.title': { zh: 'ClaudeBot 戰情室', en: 'ClaudeBot Dashboard' },
  'header.ws.connected': { zh: 'WS: 已連線', en: 'WS: connected' },
  'header.ws.disconnected': { zh: 'WS: 已斷線', en: 'WS: disconnected' },
  'header.botsOnline': { zh: '{n} 個 bot 在線', en: '{n} bot{s} online' },

  // Overview
  'overview.title': { zh: 'Bot 總覽', en: 'Bot Overview' },
  'overview.online': { zh: '{a}/{b} 在線', en: '{a}/{b} online' },
  'overview.active': { zh: '{n} 運行中', en: '{n} active' },
  'overview.queued': { zh: '{n} 排隊中', en: '{n} queued' },
  'overview.waiting': { zh: '等待心跳資料...', en: 'Waiting for heartbeat data...' },

  // Bot Card
  'bot.running': { zh: '運行中', en: 'running' },
  'bot.idle': { zh: '閒置', en: 'idle' },
  'bot.offline': { zh: '離線', en: 'offline' },
  'bot.noTasks': { zh: '無活躍任務', en: 'No active tasks' },
  'bot.heartbeatExpired': { zh: '心跳已過期', en: 'Heartbeat expired' },
  'bot.queue': { zh: '佇列', en: 'Queue' },

  // Kanban
  'kanban.title': { zh: '任務看板', en: 'Task Board' },
  'kanban.queued': { zh: '排隊中', en: 'Queued' },
  'kanban.running': { zh: '運行中', en: 'Running' },
  'kanban.done': { zh: '已完成', en: 'Done' },
  'kanban.noQueued': { zh: '無排隊任務', en: 'No queued tasks' },
  'kanban.allIdle': { zh: '所有 bot 閒置中', en: 'All bots idle' },
  'kanban.noDone': { zh: '尚無已完成任務', en: 'No completed tasks yet' },

  // Command / Chat
  'command.title': { zh: '命令', en: 'Command' },
  'command.placeholder': { zh: '輸入 prompt 發送到任意 bot...', en: 'Send a prompt to any available bot...' },
  'command.send': { zh: '發送', en: 'Send' },
  'command.sending': { zh: '發送中...', en: 'Sending...' },
  'chat.noMessages': { zh: '尚無訊息，發送 prompt 開始聊天', en: 'No messages yet. Send a prompt to get started.' },
  'chat.selectProject': { zh: '選擇專案開始聊天', en: 'Select a project to start chatting' },

  // Sidebar
  'sidebar.bots': { zh: 'BOTS', en: 'BOTS' },
  'sidebar.projects': { zh: '專案', en: 'PROJECTS' },
  'sidebar.channels': { zh: '頻道', en: 'CHANNELS' },
  'sidebar.noBots': { zh: '未偵測到 bot', en: 'No bots detected' },

  // Templates
  'templates.title': { zh: '模板', en: 'TEMPLATES' },
  'templates.codeReview': { zh: 'Code Review', en: 'Code Review' },
  'templates.fixBug': { zh: '修 Bug', en: 'Fix Bug' },
  'templates.newFeature': { zh: '新功能', en: 'New Feature' },
  'templates.refactor': { zh: '重構', en: 'Refactor' },
  'templates.writeTests': { zh: '寫測試', en: 'Write Tests' },

  // Model
  'model.title': { zh: '模型', en: 'MODEL' },

  // Actions
  'actions.title': { zh: '操作', en: 'ACTIONS' },
  'actions.cancelAll': { zh: '全部取消', en: 'Cancel All' },
  'actions.newSession': { zh: '新 Session', en: 'New Session' },

  // Project Panel
  'project.activeRunners': { zh: '活躍 Runner', en: 'Active Runners' },
  'project.queue': { zh: '佇列', en: 'Queue' },
  'project.noActivity': { zh: '此專案無活動', en: 'No activity on this project' },
  'project.lockedBy': { zh: '被 {holder} 鎖定', en: 'Locked by {holder}' },
  'project.items': { zh: '{n} 個項目', en: '{n} item{s}' },

  // Runner / shared
  'runner.tools': { zh: '工具: {n}', en: 'Tools: {n}' },
  'runner.lastTool': { zh: '最後: {name}', en: 'Last: {name}' },
  'sidebar.locked': { zh: '鎖定中', en: 'locked' },
  'kanban.items': { zh: '{n} 個項目', en: '{n} item{s}' },
} as const

type TranslationKey = keyof typeof translations

let currentLocale: Locale = 'zh'
const listeners = new Set<() => void>()

export function setLocale(locale: Locale): void {
  currentLocale = locale
  document.documentElement.setAttribute('data-locale', locale)
  for (const fn of listeners) fn()
}

export function getLocale(): Locale {
  return currentLocale
}

export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const entry = translations[key]
  let text: string = entry[currentLocale] ?? entry.en
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(`{${k}}`, String(v))
    }
    // Handle plural {s}
    if (vars.n !== undefined) {
      text = text.replace('{s}', Number(vars.n) !== 1 ? 's' : '')
    }
  }
  return text
}
