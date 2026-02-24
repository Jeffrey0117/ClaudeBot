export interface ActiveRunnerInfo {
  readonly projectPath: string
  readonly projectName: string
  readonly backend: string
  readonly model: string
  readonly elapsedMs: number
  readonly toolCount: number
  readonly lastTool: string | null
}

export interface BotHeartbeat {
  readonly botId: string
  readonly pid: number
  readonly updatedAt: number
  readonly queueLength: number
  readonly queueByProject: Record<string, number>
  readonly activeRunners: readonly ActiveRunnerInfo[]
  readonly locksHeld: readonly string[]
  readonly online: boolean
}

export interface DashboardCommand {
  readonly id: string
  readonly targetBot: string | null
  readonly type: 'prompt' | 'cancel' | 'select_project' | 'switch_model' | 'new_session'
  readonly payload: Record<string, unknown>
  readonly createdAt: number
  readonly status: 'pending' | 'claimed' | 'completed' | 'failed'
  readonly claimedBy: string | null
}

export interface ProjectInfo {
  readonly name: string
  readonly path: string
  readonly lockHolder: string | null
}

export interface HeartbeatMessage {
  readonly type: 'heartbeat'
  readonly bots: readonly BotHeartbeat[]
  readonly timestamp: number
}

export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: string
  readonly botId: string | null
  readonly projectName: string
  readonly timestamp: number
  readonly commandId: string | null
}

export interface ResponseChunkMessage {
  readonly type: 'response_chunk'
  readonly commandId: string
  readonly delta: string
  readonly accumulated: string
  readonly projectName: string | null
}

export interface ResponseCompleteMessage {
  readonly type: 'response_complete'
  readonly commandId: string
  readonly text: string
  readonly botId: string
  readonly cost: number
  readonly duration: number
  readonly projectName: string | null
}

export interface ResponseErrorMessage {
  readonly type: 'response_error'
  readonly commandId: string
  readonly error: string
  readonly projectName: string | null
}

export type WsMessage =
  | HeartbeatMessage
  | ResponseChunkMessage
  | ResponseCompleteMessage
  | ResponseErrorMessage
