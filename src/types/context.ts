import type { Context } from 'telegraf'
import type { ProjectInfo, AIModelSelection } from './index.js'

export interface BotSessionData {
  readonly authenticated: boolean
  readonly selectedProject: ProjectInfo | null
  readonly ai: AIModelSelection
}

export interface BotContext extends Context {
  session: BotSessionData
}
