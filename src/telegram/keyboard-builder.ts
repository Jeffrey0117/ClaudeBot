import { Markup } from 'telegraf'
import type { ProjectInfo } from '../types/index.js'
import type { AIModelSelection, AIBackend } from '../ai/types.js'

export function buildProjectKeyboard(projects: readonly ProjectInfo[]) {
  const buttons = projects.map((p) => Markup.button.callback(p.name, `project:${p.name}`))

  const rows: ReturnType<typeof Markup.button.callback>[][] = []
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2))
  }

  return Markup.inlineKeyboard(rows)
}

interface ModelOption {
  readonly label: string
  readonly backend: AIBackend
  readonly model: string
}

const AI_OPTIONS: readonly ModelOption[] = [
  { label: 'Auto', backend: 'auto', model: 'auto' },
  { label: 'Claude Haiku', backend: 'claude', model: 'haiku' },
  { label: 'Claude Sonnet', backend: 'claude', model: 'sonnet' },
  { label: 'Claude Opus', backend: 'claude', model: 'opus' },
  { label: 'Gemini Flash‑Lite', backend: 'gemini', model: 'flash-lite' },
  { label: 'Gemini Flash', backend: 'gemini', model: 'flash' },
  { label: 'Gemini Pro', backend: 'gemini', model: 'pro' },
]

export function buildModelKeyboard(current: AIModelSelection) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = []

  // Auto row
  const autoOption = AI_OPTIONS[0]
  const autoActive = current.backend === 'auto'
  rows.push([
    Markup.button.callback(
      autoActive ? `✓ ${autoOption.label}` : autoOption.label,
      `ai:${autoOption.backend}:${autoOption.model}`,
    ),
  ])

  // Claude row
  const claudeModels = AI_OPTIONS.filter((o) => o.backend === 'claude')
  rows.push(
    claudeModels.map((o) => {
      const active = current.backend === 'claude' && current.model === o.model
      return Markup.button.callback(
        active ? `✓ ${o.label}` : o.label,
        `ai:${o.backend}:${o.model}`,
      )
    })
  )

  // Gemini row
  const geminiModels = AI_OPTIONS.filter((o) => o.backend === 'gemini')
  rows.push(
    geminiModels.map((o) => {
      const active = current.backend === 'gemini' && current.model === o.model
      return Markup.button.callback(
        active ? `✓ ${o.label}` : o.label,
        `ai:${o.backend}:${o.model}`,
      )
    })
  )

  return Markup.inlineKeyboard(rows)
}

export function buildConfirmKeyboard(action: string) {
  return Markup.inlineKeyboard([
    Markup.button.callback('Yes', `confirm:${action}`),
    Markup.button.callback('No', `cancel:${action}`),
  ])
}
