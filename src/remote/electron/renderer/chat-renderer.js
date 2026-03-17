/**
 * Electron Chat Renderer — handles chat UI interactions and WebSocket message display.
 */

const api = window.electronAPI

// --- Markdown config ---

if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true })
}

/** Render markdown to sanitized HTML (bot messages only) */
function renderMarkdown(text) {
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    const el = document.createElement('span')
    el.textContent = text
    return el.innerHTML
  }
  return DOMPurify.sanitize(marked.parse(text))
}

// --- DOM references ---

const statusDot = document.getElementById('status-dot')
const statusText = document.getElementById('status-text')
const connectPanel = document.getElementById('connect-panel')
const chatPanel = document.getElementById('chat-panel')
const messagesEl = document.getElementById('messages')
const typingIndicator = document.getElementById('typing-indicator')
const messageInput = document.getElementById('message-input')
const btnConnect = document.getElementById('btn-connect')
const btnSend = document.getElementById('btn-send')
const inputUrl = document.getElementById('relay-url')
const inputCode = document.getElementById('pairing-code')

// --- State ---

/** Map of server messageId → DOM bubble element */
const bubbles = new Map()

/** Client-side message ID counter */
let localMsgId = 1

/** Timer to auto-hide typing indicator */
let typingTimer = null

const STATUS_LABELS = {
  disconnected: 'Disconnected',
  connecting: 'Connecting...',
  connected: 'Online',
}

// --- UI Helpers ---

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight
  })
}

function showTyping() {
  typingIndicator.classList.remove('hidden')
  scrollToBottom()

  // Auto-hide after 10s (safety net)
  if (typingTimer) clearTimeout(typingTimer)
  typingTimer = setTimeout(() => {
    typingIndicator.classList.add('hidden')
  }, 10_000)
}

function hideTyping() {
  typingIndicator.classList.add('hidden')
  if (typingTimer) {
    clearTimeout(typingTimer)
    typingTimer = null
  }
}

/**
 * Create a message bubble and append to the messages panel.
 * @param {number} id - Message ID for tracking edits/deletes
 * @param {string} text - Message text
 * @param {'user'|'bot'} sender
 * @param {Array<Array<{text: string, data: string}>>} [buttons]
 * @param {{ mediaUrl?: string, mediaType?: string }} [media]
 */
function appendBubble(id, text, sender, buttons, media) {
  const row = document.createElement('div')
  row.className = `bubble-row ${sender}`
  row.dataset.msgId = String(id)

  const bubble = document.createElement('div')
  bubble.className = 'bubble'

  if (sender === 'bot') {
    bubble.innerHTML = renderMarkdown(text)
  } else {
    bubble.textContent = text
  }

  // Media rendering (images)
  if (media && media.mediaUrl && media.mediaType === 'image') {
    const img = document.createElement('img')
    img.src = media.mediaUrl
    img.className = 'bubble-media'
    img.alt = 'image'
    img.addEventListener('click', () => window.open(media.mediaUrl, '_blank'))
    bubble.appendChild(img)
  }

  row.appendChild(bubble)

  if (buttons && buttons.length > 0) {
    const btnContainer = document.createElement('div')
    btnContainer.className = 'bubble-buttons'
    for (const btnRow of buttons) {
      for (const btn of btnRow) {
        const el = document.createElement('button')
        el.className = 'bubble-btn'
        el.textContent = btn.text
        el.addEventListener('click', () => {
          handleButtonClick(btn.data, id)
          // Disable all buttons in this group
          for (const b of btnContainer.querySelectorAll('.bubble-btn')) {
            b.disabled = true
          }
        })
        btnContainer.appendChild(el)
      }
    }
    row.appendChild(btnContainer)
  }

  bubbles.set(id, row)
  messagesEl.appendChild(row)
  scrollToBottom()
}

function updateBubble(id, text) {
  const row = bubbles.get(id)
  if (row) {
    const bubble = row.querySelector('.bubble')
    if (bubble) {
      const isBot = row.classList.contains('bot')
      if (isBot) {
        bubble.innerHTML = renderMarkdown(text)
      } else {
        bubble.textContent = text
      }
    }
    scrollToBottom()
  }
}

function removeBubble(id) {
  const row = bubbles.get(id)
  if (row) {
    row.remove()
    bubbles.delete(id)
  }
}

// --- Event Handlers ---

function sendMessage() {
  const text = messageInput.value.trim()
  if (!text) return

  const id = localMsgId++
  appendBubble(id, text, 'user')
  api.sendMessage(text)
  messageInput.value = ''
  messageInput.focus()
}

function handleButtonClick(data, messageId) {
  api.sendCallback(data, messageId)
}

// --- IPC Listeners ---

api.onChatMessage((msg) => {
  hideTyping()
  const media = msg.mediaUrl ? { mediaUrl: msg.mediaUrl, mediaType: msg.mediaType } : undefined
  appendBubble(msg.messageId, msg.text, 'bot', msg.buttons, media)
})

api.onChatEdit((msg) => {
  hideTyping()
  updateBubble(msg.messageId, msg.text)
})

api.onChatDelete((msg) => {
  removeBubble(msg.messageId)
})

api.onChatStatus(() => {
  showTyping()
})

api.onStatus((status) => {
  statusDot.className = 'status-dot ' + status
  statusText.textContent = STATUS_LABELS[status] || status

  if (status === 'connected') {
    connectPanel.classList.add('hidden')
    chatPanel.classList.remove('hidden')
    appendBubble(localMsgId++, 'ClaudeBot 已連線\n輸入 `/` 查看可用指令', 'bot')
    messageInput.focus()
  } else if (status === 'connecting') {
    // Auto-connect: skip connection panel, show chat with connecting state
    connectPanel.classList.add('hidden')
    chatPanel.classList.remove('hidden')
  } else if (status === 'disconnected') {
    // Only show connection panel if chat has no messages (fresh start or never connected)
    if (bubbles.size === 0) {
      connectPanel.classList.remove('hidden')
      chatPanel.classList.add('hidden')
    }
    hideTyping()
  }

  btnConnect.disabled = status !== 'disconnected'
  inputUrl.disabled = status !== 'disconnected'
  inputCode.disabled = status !== 'disconnected'
})

api.onLog((message) => {
  // Show connection errors as system messages in chat
  if (message.includes('error') || message.includes('Error')) {
    appendBubble(localMsgId++, message, 'bot')
  }
})

// --- DOM Events ---

btnConnect.addEventListener('click', () => {
  const url = inputUrl.value.trim()
  const code = inputCode.value.trim()
  if (!url || !code) return
  api.chatConnect(url, code)
})

btnSend.addEventListener('click', sendMessage)

// keydown handled by command palette section below

// Enter on pairing code → connect
inputCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    btnConnect.click()
  }
})

// --- Window controls ---

document.getElementById('btn-minimize').addEventListener('click', () => api.minimizeWindow())
document.getElementById('btn-close').addEventListener('click', () => api.closeWindow())

const btnPin = document.getElementById('btn-pin')
btnPin.addEventListener('click', async () => {
  const isOnTop = await api.toggleAlwaysOnTop()
  btnPin.classList.toggle('active', isOnTop)
})

const btnCompact = document.getElementById('btn-compact')
btnCompact.addEventListener('click', async () => {
  const compact = await api.toggleCompact()
  document.body.classList.toggle('compact', compact)
  btnCompact.textContent = compact ? '\u25F3' : '\u25FB'
})

// --- Command Palette ---

const COMMANDS = [
  { cmd: '/help',     desc: '顯示說明' },
  { cmd: '/status',   desc: '查看運行狀態' },
  { cmd: '/cancel',   desc: '停止目前程序' },
  { cmd: '/new',      desc: '新對話' },
  { cmd: '/model',    desc: '切換模型' },
  { cmd: '/projects', desc: '瀏覽與選擇專案' },
  { cmd: '/select',   desc: '快速切換專案' },
  { cmd: '/chat',     desc: '通用對話模式' },
  { cmd: '/pair',     desc: '配對遠端電腦' },
  { cmd: '/unpair',   desc: '斷開遠端配對' },
]

let paletteEl = null
let paletteItems = []
let paletteIndex = -1

function createPalette() {
  paletteEl = document.createElement('div')
  paletteEl.className = 'command-palette hidden'
  document.querySelector('.input-bar').appendChild(paletteEl)
}

function filterPalette(query) {
  const q = query.toLowerCase()
  const matches = COMMANDS.filter((c) => c.cmd.includes(q) || c.desc.includes(q))

  if (matches.length === 0) {
    hidePalette()
    return
  }

  paletteEl.innerHTML = ''
  paletteItems = []
  paletteIndex = -1

  for (const entry of matches) {
    const item = document.createElement('div')
    item.className = 'cmd-item'
    item.innerHTML = `<span class="cmd-name">${entry.cmd}</span><span class="cmd-desc">${entry.desc}</span>`
    item.addEventListener('click', () => selectPaletteItem(entry.cmd))
    paletteEl.appendChild(item)
    paletteItems.push(item)
  }

  paletteEl.classList.remove('hidden')
}

function hidePalette() {
  if (paletteEl) {
    paletteEl.classList.add('hidden')
    paletteItems = []
    paletteIndex = -1
  }
}

function selectPaletteItem(cmd) {
  messageInput.value = cmd + ' '
  hidePalette()
  messageInput.focus()
}

function movePaletteHighlight(delta) {
  if (paletteItems.length === 0) return
  if (paletteIndex >= 0) paletteItems[paletteIndex].classList.remove('active')
  paletteIndex = (paletteIndex + delta + paletteItems.length) % paletteItems.length
  paletteItems[paletteIndex].classList.add('active')
  paletteItems[paletteIndex].scrollIntoView({ block: 'nearest' })
}

createPalette()

messageInput.addEventListener('input', () => {
  const val = messageInput.value
  if (val.startsWith('/')) {
    filterPalette(val)
  } else {
    hidePalette()
  }
})

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hidePalette()
    return
  }

  const paletteVisible = paletteEl && !paletteEl.classList.contains('hidden')

  if (paletteVisible && e.key === 'ArrowDown') {
    e.preventDefault()
    movePaletteHighlight(1)
    return
  }

  if (paletteVisible && e.key === 'ArrowUp') {
    e.preventDefault()
    movePaletteHighlight(-1)
    return
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (paletteVisible && paletteIndex >= 0) {
      const cmd = COMMANDS.filter((c) => {
        const q = messageInput.value.toLowerCase()
        return c.cmd.includes(q) || c.desc.includes(q)
      })[paletteIndex]
      if (cmd) {
        selectPaletteItem(cmd.cmd)
        return
      }
    }
    hidePalette()
    sendMessage()
  }
})

// Auto-focus pairing code
inputCode.focus()
