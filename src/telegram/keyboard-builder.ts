import { Markup } from 'telegraf'
import type { ProjectInfo, ClaudeModel } from '../types/index.js'

export function buildProjectKeyboard(projects: readonly ProjectInfo[]) {
  const buttons = projects.map((p) => Markup.button.callback(p.name, `project:${p.name}`))

  const rows: ReturnType<typeof Markup.button.callback>[][] = []
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2))
  }

  return Markup.inlineKeyboard(rows)
}

export function buildModelKeyboard(currentModel: ClaudeModel) {
  const models: ClaudeModel[] = ['haiku', 'sonnet', 'opus']
  const buttons = models.map((m) => {
    const label = m === currentModel ? `✓ ${m}` : m
    return Markup.button.callback(label, `model:${m}`)
  })

  return Markup.inlineKeyboard([buttons])
}

export function buildConfirmKeyboard(action: string) {
  return Markup.inlineKeyboard([
    Markup.button.callback('Yes', `confirm:${action}`),
    Markup.button.callback('No', `cancel:${action}`),
  ])
}
