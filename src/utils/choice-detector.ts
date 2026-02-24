/**
 * Detect structured choices in Claude's response and generate
 * appropriate button configurations.
 *
 * Three response types:
 *   1. Numbered/lettered options → one button per option
 *   2. Yes/No question → ✅/❌ buttons
 *   3. Open question → no buttons (user types freely)
 */

export interface DetectedChoice {
  readonly label: string
  readonly value: string
}

export interface ChoiceResult {
  readonly type: 'options' | 'yesno' | 'open' | 'none'
  readonly choices: readonly DetectedChoice[]
}

/** Patterns for numbered/lettered options like "1. xxx" or "A) xxx" or "- **Option A**: xxx" */
const OPTION_PATTERNS = [
  // "1. text" or "1) text" or "1: text"
  /^\s*(\d+)\s*[.):\uFF0E]\s+(.+)/,
  // "A. text" or "A) text" or "a) text"
  /^\s*([A-Za-z])\s*[.):\uFF0E]\s+(.+)/,
  // "- **label**: description" or "- label: description"
  /^\s*[-*]\s+\*{0,2}(.+?)\*{0,2}\s*[:：]\s+(.+)/,
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

/** General question patterns */
const QUESTION_PATTERNS = [
  /[？?]\s*$/,
  /需要我/,
  /[Ll]et me know/,
  /[Ww]hich (one|option|approach)/,
  /你(想|要|偏好|選擇)/,
  /請(選擇|告訴|確認)/,
]

const MAX_OPTION_LABEL_LENGTH = 40
const MAX_TAIL_SCAN = 1500

export function detectChoices(text: string): ChoiceResult {
  if (!text || text.trim().length === 0) {
    return { type: 'none', choices: [] }
  }

  // Only scan the tail of the response to avoid false positives
  const tail = text.slice(-MAX_TAIL_SCAN).trim()
  const lines = tail.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)

  // Step 1: Try to detect numbered/lettered options
  const options = extractOptions(lines)
  if (options.length >= 2 && options.length <= 6) {
    return { type: 'options', choices: options }
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

  // Step 3: Check for open-ended question (no buttons, just prompt user to type)
  if (QUESTION_PATTERNS.some((p) => p.test(lastLine))) {
    return { type: 'open', choices: [] }
  }

  return { type: 'none', choices: [] }
}

const MAX_GAP_LINES = 3

function extractOptions(lines: readonly string[]): readonly DetectedChoice[] {
  const options: DetectedChoice[] = []

  // Scan from the end to find the option block
  // Options are usually at the tail, preceded by a question line
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
        // Clean up markdown bold/italic
        const cleanText = rawText.replace(/\*{1,2}(.+?)\*{1,2}/g, '$1').trim()
        const label = cleanText.length > MAX_OPTION_LABEL_LENGTH
          ? cleanText.slice(0, MAX_OPTION_LABEL_LENGTH - 1) + '\u2026'
          : cleanText
        // Prepend key for clarity: "1. text" or "A. text"
        const displayLabel = /\d/.test(key) ? `${key}. ${label}` : `${key}) ${label}`
        options.unshift({ label: displayLabel, value: cleanText })
        matched = true
        foundOptionBlock = true
        gapCount = 0
        break
      }
    }

    // Tolerate up to MAX_GAP_LINES non-option lines (description text between options)
    if (!matched && foundOptionBlock) {
      gapCount++
      if (gapCount > MAX_GAP_LINES) break
    }

    // Don't scan too far back
    if (options.length >= 6) break
  }

  return options
}
