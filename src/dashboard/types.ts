export interface ActiveRunnerInfo {
  readonly projectPath: string
  readonly projectName: string
  readonly backend: string
  readonly model: string
  readonly elapsedMs: number
  readonly toolCount: number
  readonly lastTool: string | null
  /** Label of the remote machine this runner is acting on, if any. */
  readonly machine?: string
}

/** A remote machine currently paired+connected to this bot instance. */
export interface ConnectedMachine {
  readonly label: string
  readonly code: string
  readonly hostname: string | null
  readonly connectedSince: number
}

export interface BotHeartbeat {
  readonly botId: string
  readonly pid: number
  readonly updatedAt: number
  readonly queueLength: number
  readonly queueByProject: Record<string, number>
  readonly activeRunners: readonly ActiveRunnerInfo[]
  readonly locksHeld: readonly string[]
  readonly machines: readonly ConnectedMachine[]
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
