/**
 * Shared wire protocol for WebSocket communication through
 * the relay server between MCP proxy (A-side) and remote agent (N-side).
 */

// --- Relay handshake: Agent (N-side) registers with relay ---

export interface AgentRegister {
  readonly type: 'agent_register'
  readonly code: string
}

export interface AgentRegistered {
  readonly type: 'agent_registered'
}

// --- Relay handshake: Proxy (A-side) connects through relay ---

export interface ProxyConnect {
  readonly type: 'proxy_connect'
  readonly code: string
}

export interface ProxyConnected {
  readonly type: 'proxy_connected'
}

// --- Error (used by relay for any handshake failure) ---

export interface RelayError {
  readonly type: 'error'
  readonly error: string
}

// --- Agent shutdown notification ---

export interface AgentShutdown {
  readonly type: 'agent_shutdown'
  readonly reason: string
}

// --- Tool call forwarding (unchanged, used after handshake) ---

export interface ToolCallRequest {
  readonly id: number
  readonly type: 'tool_call'
  readonly tool: string
  readonly args: Record<string, unknown>
}

export interface ToolCallResult {
  readonly id: number
  readonly type: 'tool_result'
  readonly result: string
}

export interface ToolCallError {
  readonly id: number
  readonly type: 'tool_error'
  readonly error: string
}

// --- Electron chat protocol (re-exported from chat-protocol.ts) ---

export type {
  ChatMessage,
  ChatCallback,
  ChatResponse,
  ChatEdit,
  ChatDelete,
  ChatStatus,
  ElectronChatRegister,
  ElectronChatRegistered,
  ChatInbound,
  ChatOutbound,
} from './chat-protocol.js'

// --- Union types ---

/** Messages the relay receives (includes Electron chat handshake + messages) */
export type RelayInbound =
  | AgentRegister | ProxyConnect | AgentShutdown
  | ToolCallRequest | ToolCallResult | ToolCallError
  | import('./chat-protocol.js').ElectronChatRegister
  | import('./chat-protocol.js').ChatMessage
  | import('./chat-protocol.js').ChatCallback

/** Messages the relay sends back */
export type RelayOutbound =
  | AgentRegistered | ProxyConnected | RelayError
  | ToolCallRequest | ToolCallResult | ToolCallError
  | import('./chat-protocol.js').ElectronChatRegistered
  | import('./chat-protocol.js').ChatResponse
  | import('./chat-protocol.js').ChatEdit
  | import('./chat-protocol.js').ChatDelete
  | import('./chat-protocol.js').ChatStatus
