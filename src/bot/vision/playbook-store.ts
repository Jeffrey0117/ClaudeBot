/**
 * Persistent playbook store for web agent action replay.
 *
 * A Playbook records a successful agent session's actions so they can be
 * replayed later with different fill values — saving Gemini API calls.
 *
 * Storage: data/bv-playbooks.json, keyed by playbook name.
 */

import { resolve } from 'node:path'
import { createJsonFileStore } from '../../utils/json-file-store.js'
import type { AgentStep } from '../../ai/gemini-agent-vision.js'

// --- Types ---

export interface PlaybookAction {
  readonly type: 'click' | 'click_xy' | 'deep_click' | 'fill' | 'press' | 'scroll' | 'navigate'
  readonly selector?: string
  readonly text?: string
  readonly x?: number
  readonly y?: number
  /** Semantic label for fill fields (extracted from step.thought). */
  readonly fieldLabel?: string
}

export interface Playbook {
  readonly name: string
  readonly url: string
  readonly instruction: string
  readonly actions: readonly PlaybookAction[]
  readonly createdAt: string
  readonly chatId: number
}

type PlaybookData = Record<string, Playbook>

const store = createJsonFileStore<PlaybookData>(resolve('data/bv-playbooks.json'), () => ({}))

// --- CRUD ---

export function savePlaybook(playbook: Playbook): boolean {
  const data = store.load()
  store.save({ ...data, [playbook.name]: playbook })
  return true
}

export function getPlaybook(name: string): Playbook | null {
  return store.load()[name] ?? null
}

export function listPlaybooks(): readonly Playbook[] {
  return Object.values(store.load())
}

export function deletePlaybook(name: string): boolean {
  const data = store.load()
  if (!(name in data)) return false
  const { [name]: _, ...rest } = data
  store.save(rest)
  return true
}

// --- Summaries for orchestrator ---

import type { PlaybookSummary } from '../../ai/gemini-agent-vision.js'

/** Build lightweight summaries for the AI orchestrator to match against. */
export function getPlaybookSummaries(): readonly PlaybookSummary[] {
  return listPlaybooks().map((p) => ({
    name: p.name,
    url: p.url,
    instruction: p.instruction,
    actionTypes: p.actions.map((a) => a.type).join(', '),
    fillFields: p.actions
      .filter((a) => a.type === 'fill')
      .map((a) => a.fieldLabel ?? a.selector ?? 'unknown'),
  }))
}

/** Filter playbook summaries to those matching a given URL's domain. */
export function getSkillsForDomain(url: string): readonly PlaybookSummary[] {
  const summaries = getPlaybookSummaries()
  try {
    const targetHost = new URL(url).hostname
    return summaries.filter((s) => {
      try { return new URL(s.url).hostname === targetHost }
      catch { return false }
    })
  } catch {
    return []
  }
}

/** Format playbook skills as prompt text for the Gemini agent. */
export function buildSkillsPrompt(skills: readonly PlaybookSummary[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((s) =>
    `- "${s.name}": ${s.instruction} (actions: ${s.actionTypes})` +
    (s.fillFields.length > 0 ? `. Fill fields: [${s.fillFields.join(', ')}]` : ''),
  ).join('\n')

  return (
    '\n\nAVAILABLE PLAYBOOK SKILLS:\n' +
    'You can invoke a previously recorded automation workflow using action type "use_playbook" with the playbook name in the "text" field.\n' +
    'Use this when you recognize a sub-task a playbook can handle (e.g., need to login → use login playbook, need to fill a form you\'ve done before).\n' +
    'Fill values are automatically extracted from the user instruction.\n\n' +
    lines
  )
}

// --- Extract actions from agent steps ---

export function extractPlaybookActions(steps: readonly AgentStep[]): readonly PlaybookAction[] {
  return steps
    .filter((s) => s.action.type !== 'done')
    .map((s): PlaybookAction => {
      const type = s.action.type as PlaybookAction['type']
      return {
        type,
        ...(s.action.selector ? { selector: s.action.selector } : {}),
        ...(s.action.text ? { text: s.action.text } : {}),
        ...(s.action.x != null ? { x: s.action.x } : {}),
        ...(s.action.y != null ? { y: s.action.y } : {}),
        ...(s.action.type === 'fill' ? { fieldLabel: extractFieldLabel(s.thought, s.action.selector) } : {}),
      }
    })
}

/** Best-effort extraction of a human-readable field label from the agent's thought. */
function extractFieldLabel(thought: string, selector?: string): string {
  // Try to find patterns like "fill the title field" / "enter password" / "type in email"
  const patterns = [
    /(?:fill|enter|type|input|write|put)\s+(?:in\s+)?(?:the\s+)?["']?([^"'\n,]+?)["']?\s*(?:field|input|box|area)/i,
    /(?:field|input)\s+["']?([^"'\n,]+?)["']?/i,
  ]

  for (const re of patterns) {
    const m = thought.match(re)
    if (m?.[1]) return m[1].trim()
  }

  // Fallback: use selector name attribute if available
  if (selector) {
    const nameMatch = selector.match(/name="([^"]+)"/)
    if (nameMatch?.[1]) return nameMatch[1]
    const placeholderMatch = selector.match(/placeholder="([^"]+)"/)
    if (placeholderMatch?.[1]) return placeholderMatch[1]
  }

  // Avoid leaking potentially sensitive thought content
  return selector ? `field:${selector.slice(0, 30)}` : 'unknown-field'
}
