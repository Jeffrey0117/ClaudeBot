import type { AIModelSelection } from './types.js'
import { env } from '../config/env.js'

/** Keywords that indicate complex architecture/design tasks → Claude Opus */
const TIER3_KEYWORDS = [
  'architect', 'design', 'refactor', 'migrate', 'scale',
  '架構', '設計', '重構', '遷移', '大規模',
]

/** Keywords that indicate complex coding tasks → Claude Sonnet */
const TIER2_KEYWORDS = [
  'implement', 'debug', 'fix', 'test', 'review', 'deploy',
  'typescript', 'react', 'database', 'api', 'security',
  '實作', '修復', '測試', '部署', '安全',
]

/** Short message threshold — messages shorter than this may route to Gemini */
const SHORT_MESSAGE_LENGTH = 200

/**
 * Auto-route a prompt to the best AI backend based on content analysis.
 *
 * Routing tiers:
 *   Tier 3: Architecture/design keywords → Claude Opus
 *   Tier 2: Complex coding + has project context → Claude Sonnet
 *   Tier 1: Short simple messages, no code indicators → Gemini Flash
 *   Default: Claude Sonnet
 */
export function autoRoute(prompt: string, hasProject: boolean): AIModelSelection {
  const lower = prompt.toLowerCase()

  // Tier 3: Architecture/design → Claude Opus
  if (TIER3_KEYWORDS.some((kw) => lower.includes(kw))) {
    return { backend: 'claude', model: 'opus' }
  }

  // Tier 2: Complex coding with project context → Claude Sonnet
  if (hasProject && TIER2_KEYWORDS.some((kw) => lower.includes(kw))) {
    return { backend: 'claude', model: 'sonnet' }
  }

  // Tier 1: Short simple messages without code indicators → Gemini Flash
  const hasCodeIndicators = /```|function |class |import |const |let |def |=>/.test(prompt)
  const isShort = prompt.length < SHORT_MESSAGE_LENGTH

  if (isShort && !hasCodeIndicators && !hasProject && env.GEMINI_API_KEY) {
    return { backend: 'gemini', model: 'flash' }
  }

  // Default: Claude Sonnet
  return { backend: 'claude', model: env.DEFAULT_MODEL }
}
