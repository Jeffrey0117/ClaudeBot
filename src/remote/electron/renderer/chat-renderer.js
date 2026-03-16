/**
 * Electron Chat Renderer — handles chat UI interactions and WebSocket message display.
 */

const api = window.electronAPI

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
 */
function appendBubble(id, text, sender, buttons) {
  const row = document.createElement('div')
  row.className = `bubble-row ${sender}`
  row.dataset.msgId = String(id)

  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = text
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
    if (bubble) bubble.textContent = text
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
  appendBubble(msg.messageId, msg.text, 'bot', msg.buttons)
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
    messageInput.focus()
  } else if (status === 'disconnected') {
    connectPanel.classList.remove('hidden')
    chatPanel.classList.add('hidden')
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

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
})

// Enter on pairing code → connect
inputCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    btnConnect.click()
  }
})

// Auto-focus pairing code
inputCode.focus()
