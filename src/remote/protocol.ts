/**
 * Shared wire protocol for WebSocket communication between
 * the MCP proxy (A-side) and the remote agent (N-side).
 */

// --- Pairing handshake ---

export interface PairRequest {
  readonly type: 'pair'
  readonly code: string
}

export interface PairOk {
  readonly type: 'pair_ok'
}

export interface PairFail {
  readonly type: 'pair_fail'
  readonly error: string
}

// --- Tool call forwarding ---

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

// --- Union types ---

export type ProxyMessage = PairRequest | ToolCallRequest
export type AgentResponse = PairOk | PairFail | ToolCallResult | ToolCallError
