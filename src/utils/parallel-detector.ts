/**
 * Smart detection: does the user's message look like multiple independent tasks?
 * If so, suggest /parallel instead of sending to a single Claude session.
 */

/** Minimum tasks to trigger suggestion. */
const MIN_TASKS = 2

/** Max chars to scan (skip very long messages — probably not task lists). */
const MAX_SCAN_LENGTH = 2000

/** Keywords that indicate "do multiple things". */
const MULTI_TASK_KEYWORDS = [
  '同時', '分別', '各自', '平行', '並行',
  '幫我做', '幫我寫', '幫我建',
  '然後', '還有', '另外', '接著',
  'simultaneously', 'in parallel', 'at the same time',
]

/** Keywords that make it NOT a task list (analysis/explanation requests). */
const EXCLUSION_KEYWORDS = [
  '比較', '差異', '差別', '說明', '解釋', '分析',
  '為什麼', '怎麼', '如何',
  'compare', 'explain', 'difference', 'why', 'how does',
]

export interface ParallelSuggestion {
  readonly tasks: readonly string[]
  readonly confidence: 'high' | 'medium'
}

/**
 * Analyze user text to see if it looks like multiple independent tasks.
 * Returns null if not a parallel candidate, or a suggestion with parsed tasks.
 */
export function detectParallelCandidate(text: string): ParallelSuggestion | null {
  if (!text || text.length > MAX_SCAN_LENGTH) return null

  const lower = text.toLowerCase()

  // Exclusion: if it looks like a question or analysis request, skip
  if (EXCLUSION_KEYWORDS.some((kw) => lower.includes(kw))) return null

  // Strategy 1: Numbered list (highest confidence)
  const numberedTasks = parseNumberedList(text)
  if (numberedTasks.length >= MIN_TASKS) {
    return { tasks: numberedTasks, confidence: 'high' }
  }

  // Strategy 2: Bullet/dash list
  const bulletTasks = parseBulletList(text)
  if (bulletTasks.length >= MIN_TASKS) {
    return { tasks: bulletTasks, confidence: 'high' }
  }

  // Strategy 3: Multi-task keywords with line breaks
  if (hasMultiTaskPattern(text)) {
    const lineTasks = parseLineBreakTasks(text)
    if (lineTasks.length >= MIN_TASKS) {
      return { tasks: lineTasks, confidence: 'medium' }
    }
  }

  return null
}

/** Parse numbered list: "1. xxx\n2. yyy\n3. zzz" */
function parseNumberedList(text: string): readonly string[] {
  const lines = text.split('\n')
  const tasks: string[] = []

  for (const line of lines) {
    const match = line.match(/^\s*\d+[.)]\s+(.+)/)
    if (match) {
      const task = match[1].trim()
      if (task.length >= 3) tasks.push(task)
    }
  }

  return tasks
}

/** Parse bullet list: "- xxx\n- yyy" or "• xxx\n• yyy" */
function parseBulletList(text: string): readonly string[] {
  const lines = text.split('\n')
  const tasks: string[] = []

  for (const line of lines) {
    const match = line.match(/^\s*[-*•]\s+(.+)/)
    if (match) {
      const task = match[1].trim()
      if (task.length >= 3) tasks.push(task)
    }
  }

  return tasks
}

/** Check if text has multi-task keywords. */
function hasMultiTaskPattern(text: string): boolean {
  const lower = text.toLowerCase()
  return MULTI_TASK_KEYWORDS.some((kw) => lower.includes(kw))
}

/** Split by line breaks and filter meaningful lines (for keyword-detected messages). */
function parseLineBreakTasks(text: string): readonly string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 5)
    .filter((l) => !l.match(/^(然後|還有|另外|接著|同時|分別)/))
}
