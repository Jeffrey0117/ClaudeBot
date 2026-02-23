import type { BotContext } from './context.js'

export interface PluginCommand {
  readonly name: string
  readonly description: string
  readonly handler: (ctx: BotContext) => Promise<void>
}

export interface Plugin {
  readonly name: string
  readonly description: string
  readonly commands: readonly PluginCommand[]
  readonly onMessage?: (ctx: BotContext) => Promise<boolean>
  readonly cleanup?: () => Promise<void>
}
