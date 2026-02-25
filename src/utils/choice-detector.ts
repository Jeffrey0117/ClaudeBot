/**
 * Detect structured choices in Claude's response and generate
 * appropriate button configurations.
 *
 * Three response types:
 *   1. Numbered/lettered options + selection prompt → one button per option
 *   2. Yes/No question → confirm buttons
 *   3. Open question → no buttons (user types freely)
 *
 * Key: numbered lists are ONLY treated as options if
 * accompanied by a selection prompt (e.g. "哪個？", "Which one?", "要做哪些？").
 * Otherwise they're just explanatory lists → no buttons.
 */

export interface DetectedChoice {
  readonly label: string
  readonly value: string
}

export interface ChoiceResult {
  readonly type: 'options' | 'yesno' | 'open' | 'none'
  readonly choices: readonly DetectedChoice[]
}

/** Patterns for numbered/lettered options like "1. xxx" or "A) xxx" */
const OPTION_PATTERNS = [
  /^\s*(\d+)\s*[.):\uFF0E]\s+(.+)/,
  /^\s*([A-Za-z])\s*[.):\uFF0E]\s+(.+)/,
  /^\s*[-*]\s+\*{0,2}(.+?)\*{0,2}\s*[:：]\s+(.+)/,
  /^\s*方案\s*([A-Za-z])\s*[：:.]?\s*(.+)/,
  /^\s*[（(]\s*(\d+)\s*[)）]\s*[.:：]?\s*(.+)/,
]

/** Yes/No question patterns (checked against last meaningful line) */
const YESNO_PATTERNS = [
  /要繼續嗎/,
  /要我繼續/,
  /是否要/,
  /要不要/,
  /可以嗎/,
  /好嗎/,
  /確定嗎/,
  /同意嗎/,
  /[Ss]hould I (proceed|continue|go ahead)/,
  /[Dd]o you want (me )?to/,
  /[Ss]hall I/,
  /[Ww]ould you like (me )?to/,
  /[Cc]an I go ahead/,
  /[Ww]ant me to/,
  /[Rr]eady to proceed/,
]

/** Patterns that indicate the list is a SELECTION prompt (user must choose) */
const SELECTION_PROMPT_PATTERNS = [
  // Chinese
  /你(覺得|想|要|偏好|選擇)(做)?哪/,
  /要做哪/,
  /選哪/,
  /想做哪/,
  /選擇哪/,
  /要哪個/,
  /做哪個/,
  /哪個好/,
  /你選/,
  /請選/,
  /先做哪/,
  /優先/,

  /建議.*哪/,
  /推薦.*哪/,

  // English
  /[Ww]hich (one|option|approach|method|way)/,
  /[Ww]hat would you (prefer|like|choose)/,
  /[Pp]ick (one|a|an)/,
  /[Cc]hoose (one|from|between)/,
  /[Ww]hat do you think/,
  /[Ww]hat('s| is) your (preference|choice)/,
  /[Ll]et me know (which|what)/,
  /[Ww]hich do you/,
]

/** General question patterns (open-ended, no buttons) */
const QUESTION_PATTERNS = [
  /[？?]\s*$/,
  /需要我/,
  /[Ll]et me know/,
]

const MAX_OPTION_LABEL_LENGTH = 40
const MAX_TAIL_SCAN = 1500

export function detectChoices(text: string): ChoiceResult {
  if (!text || text.trim().length === 0) {
    return { type: 'none', choices: [] }
  }

  const tail = text.slice(-MAX_TAIL_SCAN).trim()
  const lines = tail.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)

  // Step 1: Try to detect numbered/lettered options
  const options = extractOptions(lines)
  if (options.length >= 2 && options.length <= 6 && !looksLikeExplanation(options)) {
    // CRITICAL: Only treat as selectable options if there's a selection prompt nearby
    if (hasSelectionPrompt(lines)) {
      return { type: 'options', choices: options }
    }

    // Fallback: if a selection-like question appears in the 5 lines above the options,
    // treat as implicit choice (Claude often asks a question then lists options)
    if (hasSelectionQuestionAboveOptions(lines, options.length)) {
      return { type: 'options', choices: options }
    }
    // Numbered list without selection prompt = just an explanation, no buttons
  }

  // Step 2: Check for yes/no question
  const lastLine = lines.at(-1) ?? ''
  if (YESNO_PATTERNS.some((p) => p.test(lastLine))) {
    return {
      type: 'yesno',
      choices: [
        { label: '\u2705 \u662F Yes', value: '\u662F\uFF0C\u8ACB\u7E7C\u7E8C' },
        { label: '\u274C \u5426 No', value: '\u4E0D\u7528\u4E86' },
      ],
    }
  }

  // Step 3: Check for open-ended question
  if (QUESTION_PATTERNS.some((p) => p.test(lastLine))) {
    return { type: 'open', choices: [] }
  }

  return { type: 'none', choices: [] }
}

/**
 * Check if the tail text contains a selection prompt — a line that asks
 * the user to pick/choose from the listed options.
 *
 * Scans the last 15 lines for selection-related phrases.
 */
function hasSelectionPrompt(lines: readonly string[]): boolean {
  const scanLines = lines.slice(-15)
  for (const line of scanLines) {
    if (SELECTION_PROMPT_PATTERNS.some((p) => p.test(line))) {
      return true
    }
  }
  return false
}

/**
 * Detect explanatory lists (past-tense actions) vs. actual choices.
 * "我做了：1. 修改了 X  2. 新增了 Y" → explanation, no buttons.
 */
/**
 * Markers that indicate "describing what happened/will happen", not "pick one".
 * Past tense: 修改了, 新增了, 完成了...
 * Future/state: 會自動, 會被, 應該能, 將會...
 * Structure: **bold** — explanation (common Claude documentation pattern)
 */
const EXPLANATION_MARKERS = /修改了|新增了|更新了|刪除了|移除了|完成了|設定了|做了|加了|改了|已經|已完成|會自動|會被|應該能|將會|將被/
const EXPLANATION_STRUCTURE = /\*{2}.+?\*{2}\s*[—\-：:]\s*.+/
/** Technical descriptions: "name (`cmd`) — explanation" or "name (technical_term) — desc" */
const TECHNICAL_DESC = /[`（(].+?[`）)]\s*[—\-：:]/

function looksLikeExplanation(options: readonly DetectedChoice[]): boolean {
  const matchCount = options.filter(
    (o) => EXPLANATION_MARKERS.test(o.value) || EXPLANATION_STRUCTURE.test(o.value) || TECHNICAL_DESC.test(o.value)
  ).length
  // >= half means "probably explanation" (1/2 = block, 1/3 = pass)
  return matchCount >= options.length / 2
}

/**
 * Tightened fallback: only trigger if the question above options
 * contains selection-related keywords (哪, 選, 要, 想, prefer, which, pick).
 * A bare "?" is not enough — it could be "你覺得怎樣？" (feedback, not choice).
 */
const SELECTION_QUESTION_KEYWORDS = /哪|選|要.*做|想.*做|偏好|prefer|which|pick|choose/i

function hasSelectionQuestionAboveOptions(lines: readonly string[], optionCount: number): boolean {
  const aboveStart = Math.max(0, lines.length - optionCount - 5)
  const aboveEnd = lines.length - optionCount
  for (let i = aboveStart; i < aboveEnd; i++) {
    if (/[？?]/.test(lines[i]) && SELECTION_QUESTION_KEYWORDS.test(lines[i])) {
      return true
    }
  }
  return false
}

const MAX_GAP_LINES = 3

function extractOptions(lines: readonly string[]): readonly DetectedChoice[] {
  const options: DetectedChoice[] = []

  let foundOptionBlock = false
  let gapCount = 0

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    let matched = false

    for (const pattern of OPTION_PATTERNS) {
      const match = line.match(pattern)
      if (match) {
        const key = match[1]
        const rawText = match[2]
        const cleanText = rawText.replace(/\*{1,2}(.+?)\*{1,2}/g, '$1').trim()
        const label = cleanText.length > MAX_OPTION_LABEL_LENGTH
          ? cleanText.slice(0, MAX_OPTION_LABEL_LENGTH - 1) + '\u2026'
          : cleanText
        const displayLabel = /\d/.test(key) ? `${key}. ${label}` : `${key}) ${label}`
        options.unshift({ label: displayLabel, value: cleanText })
        matched = true
        foundOptionBlock = true
        gapCount = 0
        break
      }
    }

    if (!matched && foundOptionBlock) {
      gapCount++
      if (gapCount > MAX_GAP_LINES) break
    }

    if (options.length >= 6) break
  }

  return options
}
