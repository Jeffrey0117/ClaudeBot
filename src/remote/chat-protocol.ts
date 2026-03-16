/**
 * Chat protocol types for Electron ↔ Bot communication via WebSocket relay.
 *
 * Electron acts as a full chat client — messages route through TelegramProxy
 * so the entire bot pipeline (queue, commands, plugins) works unchanged.
 */

// --- Electron → Relay → Bot ---

export interface ChatMessage {
  readonly type: 'chat_message'
  readonly text: string
  readonly messageId: number
}

export interface ChatCallback {
  readonly type: 'chat_callback'
  readonly data: string
  readonly messageId: number
}

// --- Bot → Relay → Electron ---

export interface ChatResponse {
  readonly type: 'chat_response'
  readonly messageId: number
  readonly text: string
  readonly parseMode?: 'Markdown' | 'HTML'
  readonly buttons?: ReadonlyArray<ReadonlyArray<{ readonly text: string; readonly data: string }>>
}

export interface ChatEdit {
  readonly type: 'chat_edit'
  readonly messageId: number
  readonly text: string
}

export interface ChatDelete {
  readonly type: 'chat_delete'
  readonly messageId: number
}

export interface ChatStatus {
  readonly type: 'chat_status'
  readonly status: 'typing' | 'processing'
}

// --- Handshake ---

export interface ElectronChatRegister {
  readonly type: 'electron_chat_register'
  readonly code: string
  readonly clientId: string
}

export interface ElectronChatRegistered {
  readonly type: 'electron_chat_registered'
  readonly virtualChatId: number
}

// --- Union helpers ---

export type ChatInbound = ChatMessage | ChatCallback
export type ChatOutbound = ChatResponse | ChatEdit | ChatDelete | ChatStatus
