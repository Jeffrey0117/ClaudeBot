/**
 * Post-process Claude's response for cleaner Telegram display.
 * Pure text transforms — zero AI cost, zero latency.
 */

const MAX_CODE_BLOCK_LINES = 15
const CODE_BLOCK_RE = /```(\w*)\n([\s\S]*?)```/g

/**
 * Clean up markdown for better Telegram mobile display:
 * - Collapse excessive blank lines
 * - Truncate long code blocks
 * - Remove trailing whitespace
 */
export function cleanMarkdown(text: string): string {
  let result = text

  // 1. Collapse 3+ consecutive blank lines → 2
  result = result.replace(/\n{4,}/g, '\n\n\n')

  // 2. Truncate long code blocks
  result = result.replace(CODE_BLOCK_RE, (_match, lang: string, code: string) => {
    const lines = code.split('\n')
    if (lines.length <= MAX_CODE_BLOCK_LINES) {
      return `\`\`\`${lang}\n${code}\`\`\``
    }
    const truncated = lines.slice(0, MAX_CODE_BLOCK_LINES).join('\n')
    const remaining = lines.length - MAX_CODE_BLOCK_LINES
    return `\`\`\`${lang}\n${truncated}\n// ... (${remaining} more lines)\n\`\`\``
  })

  // 3. Remove trailing whitespace on each line
  result = result.replace(/[ \t]+$/gm, '')

  return result.trim()
}
