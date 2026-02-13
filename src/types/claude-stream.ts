export interface StreamMessageStart {
  readonly type: 'message_start'
  readonly message: {
    readonly id: string
    readonly model: string
  }
}

export interface StreamContentBlockStart {
  readonly type: 'content_block_start'
  readonly index: number
  readonly content_block: {
    readonly type: 'text' | 'tool_use'
    readonly text?: string
    readonly name?: string
  }
}

export interface StreamContentBlockDelta {
  readonly type: 'content_block_delta'
  readonly index: number
  readonly delta: {
    readonly type: 'text_delta' | 'input_json_delta'
    readonly text?: string
  }
}

export interface StreamContentBlockStop {
  readonly type: 'content_block_stop'
  readonly index: number
}

export interface StreamResult {
  readonly type: 'result'
  readonly subtype: 'success' | 'error'
  readonly session_id: string
  readonly cost_usd?: number
  readonly total_cost_usd?: number
  readonly duration_ms: number
  readonly duration_api_ms: number
  readonly is_error: boolean
  readonly num_turns: number
  readonly result?: string
  readonly error?: string
}

export interface StreamAssistantMessage {
  readonly type: 'assistant'
  readonly message: {
    readonly content: ReadonlyArray<{
      readonly type: 'text' | 'tool_use'
      readonly text?: string
      readonly name?: string
    }>
  }
}

export interface StreamSystemMessage {
  readonly type: 'system'
  readonly subtype: string
  readonly message: string
}

export type StreamEvent =
  | StreamMessageStart
  | StreamContentBlockStart
  | StreamContentBlockDelta
  | StreamContentBlockStop
  | StreamAssistantMessage
  | StreamResult
  | StreamSystemMessage
