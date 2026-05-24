/**
 * Automatic memory consolidation (Mem0 concept).
 *
 * Every N responses, uses Gemini Flash to analyze recent responses
 * + existing pins, and produces ADD/UPDATE/DELETE decisions.
 * Runs in the background — never blocks the main response pipeline.
 */
import { env } from '../config/env.js'
import { getPins, addPin, removePin, updatePin } from './context-pin-store.js'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const CONSOLIDATION_INTERVAL = 5
const TIMEOUT_MS = 30_000

// Track response count per project
const responseCounts = new Map<string, number>()
// Track recent response texts per project (rolling window)
const recentResponses = new Map<string, string[]>()
const MAX_RECENT = 5

interface ConsolidationAction {
  readonly type: 'ADD' | 'UPDATE' | 'DELETE'
  readonly index?: number
  readonly text?: string
}

export function recordResponse(projectPath: string, responseText: string): void {
  const count = (responseCounts.get(projectPath) ?? 0) + 1
  responseCounts.set(projectPath, count)

  const recent = recentResponses.get(projectPath) ?? []
  // Keep a trimmed version (first 500 chars of each)
  recent.push(responseText.slice(0, 500))
  if (recent.length > MAX_RECENT) recent.shift()
  recentResponses.set(projectPath, recent)

  if (count % CONSOLIDATION_INTERVAL === 0) {
    consolidate(projectPath).catch((err) => {
      console.error('[memory-consolidator] consolidation failed:', err)
    })
  }
}

async function consolidate(projectPath: string): Promise<void> {
  if (!env.GEMINI_API_KEY) return

  const pins = getPins(projectPath)
  const recent = recentResponses.get(projectPath) ?? []
  if (recent.length === 0) return

  const pinsText = pins.length > 0
    ? pins.map((p, i) => `${i + 1}. ${p.text}`).join('\n')
    : '(none)'

  const recentText = recent.map((r, i) => `--- Response ${i + 1} ---\n${r}`).join('\n\n')

  const prompt =
    `你是記憶管理助手。分析以下近期對話回應和現有釘選記憶，決定是否需要新增、更新或刪除記憶。\n\n` +
    `現有釘選記憶:\n${pinsText}\n\n` +
    `近期回應摘要:\n${recentText}\n\n` +
    `規則:\n` +
    `- 只在真正有價值時才操作（用戶偏好、重要決策、專案狀態變化）\n` +
    `- 不要釘選瑣碎或暫時性的資訊\n` +
    `- 釘選上限 10 則，需要時先刪除過時的\n` +
    `- 如果不需要任何操作，回傳空 JSON 陣列\n\n` +
    `回傳 JSON 陣列，每個元素格式:\n` +
    `{"type":"ADD","text":"要新增的記憶"}\n` +
    `{"type":"UPDATE","index":1,"text":"更新後的記憶"}\n` +
    `{"type":"DELETE","index":2}\n` +
    `\n只回傳 JSON 陣列，不要其他文字。`

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(
      `${API_BASE}/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    )
    clearTimeout(timeout)

    if (!res.ok) return

    const data = (await res.json()) as {
      candidates?: ReadonlyArray<{
        content?: { parts?: ReadonlyArray<{ text?: string }> }
      }>
    }

    const text = data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('') ?? ''

    if (!text) return

    const actions = JSON.parse(text) as ConsolidationAction[]
    if (!Array.isArray(actions) || actions.length === 0) return

    // Execute actions in reverse order for DELETE (to preserve indices)
    const sorted = [...actions].sort((a, b) => {
      if (a.type === 'DELETE' && b.type !== 'DELETE') return 1
      if (a.type !== 'DELETE' && b.type === 'DELETE') return -1
      // For DELETEs, process higher indices first
      if (a.type === 'DELETE' && b.type === 'DELETE') {
        return (b.index ?? 0) - (a.index ?? 0)
      }
      return 0
    })

    for (const action of sorted) {
      switch (action.type) {
        case 'ADD':
          if (action.text) addPin(projectPath, action.text)
          break
        case 'UPDATE':
          if (action.index !== undefined && action.text) {
            updatePin(projectPath, action.index - 1, action.text)
          }
          break
        case 'DELETE':
          if (action.index !== undefined) {
            removePin(projectPath, action.index - 1)
          }
          break
      }
    }
  } catch {
    // Silent fail — consolidation is best-effort
  }
}
