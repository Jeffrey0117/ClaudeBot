import type { Context } from 'telegraf'
import type { ClaudeModel, ProjectInfo } from './index.js'

export interface BotSessionData {
  readonly authenticated: boolean
  readonly selectedProject: ProjectInfo | null
  readonly model: ClaudeModel
}

export interface BotContext extends Context {
  session: BotSessionData
}
