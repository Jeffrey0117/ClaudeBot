export interface ChainStep {
  readonly type: 'bv' | 'pipe' | 'notify' | 'wait' | 'cmd'
  readonly instruction: string
}

export interface Chain {
  readonly name: string
  readonly steps: readonly ChainStep[]
  readonly chatId: number
  readonly createdAt: string
  readonly schedule?: string // "HH:MM" daily schedule
}

export interface ChainRunResult {
  readonly chainName: string
  readonly success: boolean
  readonly stepResults: readonly StepResult[]
  readonly error?: string
}

export interface StepResult {
  readonly stepIndex: number
  readonly type: ChainStep['type']
  readonly instruction: string
  readonly output: string
  readonly success: boolean
  readonly durationMs: number
}
