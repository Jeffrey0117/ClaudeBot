import { resolve } from 'node:path'
import { createJsonFileStore } from '../utils/json-file-store.js'

export interface LearnedRule {
  readonly rule: string
  readonly learnedAt: string
  readonly hitCount: number
  readonly source: string
}

const MAX_RULES = 5

type RulesData = Record<string, LearnedRule[]>

const store = createJsonFileStore<RulesData>(resolve('data/learned-rules.json'), () => ({}))

export function addLearnedRule(
  projectPath: string,
  rule: string,
  source = 'ai',
): { added: boolean; evicted: string | null } {
  const data = store.load()
  const list = [...(data[projectPath] ?? [])]

  // Check for duplicate
  const existing = list.findIndex((r) => r.rule === rule)
  if (existing !== -1) {
    // Bump hitCount instead
    list[existing] = { ...list[existing], hitCount: list[existing].hitCount + 1 }
    store.save({ ...data, [projectPath]: list })
    return { added: true, evicted: null }
  }

  let evicted: string | null = null
  if (list.length >= MAX_RULES) {
    // Evict lowest hitCount
    let minIdx = 0
    for (let i = 1; i < list.length; i++) {
      if (list[i].hitCount < list[minIdx].hitCount) minIdx = i
    }
    evicted = list[minIdx].rule
    list.splice(minIdx, 1)
  }

  const item: LearnedRule = {
    rule,
    learnedAt: new Date().toISOString(),
    hitCount: 0,
    source,
  }
  list.push(item)
  store.save({ ...data, [projectPath]: list })
  return { added: true, evicted }
}

export function getLearnedRules(projectPath: string): readonly LearnedRule[] {
  const data = store.load()
  return data[projectPath] ?? []
}

export function touchLearnedRules(projectPath: string): void {
  const data = store.load()
  const list = data[projectPath] ?? []
  if (list.length === 0) return

  const updated = list.map((r) => ({ ...r, hitCount: r.hitCount + 1 }))
  store.save({ ...data, [projectPath]: updated })
}

export function formatRulesForPrompt(projectPath: string): string {
  const rules = getLearnedRules(projectPath)
  if (rules.length === 0) return ''

  const lines = rules.map((r, i) => `${i + 1}. ${r.rule}`)
  return `[行為規則]\n${lines.join('\n')}\n` +
    `你可以用 @learn(規則) 新增行為規則（上限 ${MAX_RULES} 則，滿了自動淘汰最少用的）。\n` +
    `[/行為規則]`
}
