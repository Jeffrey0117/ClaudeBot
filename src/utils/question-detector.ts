/**
 * Detect if Claude's response ends with a question that warrants
 * [Yes / No] confirmation buttons.
 */

const QUESTION_PATTERNS = [
  // Chinese
  /[？]$/,
  /要繼續嗎/,
  /要我繼續/,
  /是否要/,
  /要不要/,
  /需要我/,
  /可以嗎/,
  /好嗎/,
  /確定嗎/,
  /同意嗎/,
  // English
  /\?$/,
  /[Ss]hould I (proceed|continue|go ahead)/,
  /[Dd]o you want (me )?to/,
  /[Ss]hall I/,
  /[Ww]ould you like (me )?to/,
  /[Cc]an I go ahead/,
  /[Ww]ant me to/,
  /[Rr]eady to proceed/,
  /[Ll]et me know if/,
]

export function detectQuestion(text: string): boolean {
  // Only look at the tail — avoid false positives from mid-response questions
  const tail = text.slice(-500).trim()
  if (!tail) return false

  // Check last meaningful line
  const lines = tail.split('\n').filter((l) => l.trim().length > 0)
  const lastLine = lines.at(-1)?.trim() ?? ''

  return QUESTION_PATTERNS.some((p) => p.test(lastLine))
}
