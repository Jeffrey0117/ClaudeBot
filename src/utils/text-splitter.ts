const TELEGRAM_MAX_LENGTH = 4096

/** Chars reserved per chunk for re-balancing code fences (close + reopen). */
const FENCE_RESERVE = 16

export function splitText(text: string, maxLength = TELEGRAM_MAX_LENGTH): readonly string[] {
  if (text.length <= maxLength) {
    return [text]
  }

  const hasFences = text.includes('```')
  const effectiveMax = hasFences ? maxLength - FENCE_RESERVE : maxLength

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= effectiveMax) {
      chunks.push(remaining)
      break
    }

    // Priority: paragraph boundary > single newline > space > hard cut
    let splitIndex = remaining.lastIndexOf('\n\n', effectiveMax)
    if (splitIndex === -1 || splitIndex < effectiveMax * 0.3) {
      splitIndex = remaining.lastIndexOf('\n', effectiveMax)
    }
    if (splitIndex === -1 || splitIndex < effectiveMax * 0.3) {
      splitIndex = remaining.lastIndexOf(' ', effectiveMax)
    }
    if (splitIndex === -1 || splitIndex < effectiveMax * 0.3) {
      splitIndex = effectiveMax
    }

    chunks.push(remaining.slice(0, splitIndex))
    remaining = remaining.slice(splitIndex).trimStart()
  }

  return hasFences ? balanceCodeFences(chunks) : chunks
}

/**
 * A chunk boundary can land inside a ``` block, which breaks Markdown entity
 * parsing on BOTH resulting messages. Close any fence left open at a chunk's
 * end and reopen it (same language) at the start of the next chunk.
 */
function balanceCodeFences(chunks: readonly string[]): readonly string[] {
  const out: string[] = []
  let openLang: string | null = null // null = not inside a fence

  for (const chunk of chunks) {
    let c = openLang !== null ? '```' + openLang + '\n' + chunk : chunk

    // Walk the fences in this (possibly prefixed) chunk to find the end state
    let inside = false
    let lang = ''
    const fenceRe = /^[ \t]*```([^\s`]*)/gm
    let m: RegExpExecArray | null
    while ((m = fenceRe.exec(c)) !== null) {
      if (!inside) {
        inside = true
        lang = m[1] ?? ''
      } else {
        inside = false
        lang = ''
      }
    }

    if (inside) {
      c += '\n```'
      openLang = lang
    } else {
      openLang = null
    }

    out.push(c)
  }

  return out
}

export function tailText(text: string, maxLength = TELEGRAM_MAX_LENGTH): string {
  if (text.length <= maxLength) {
    return text
  }
  const prefixReserve = Math.min(15, Math.floor(maxLength / 3))
  const truncated = text.slice(-maxLength + prefixReserve)
  const newlineIndex = truncated.indexOf('\n')
  const cleanStart = newlineIndex > 0 && newlineIndex < 100 ? newlineIndex + 1 : 0
  return `... (truncated)\n${truncated.slice(cleanStart)}`
}
