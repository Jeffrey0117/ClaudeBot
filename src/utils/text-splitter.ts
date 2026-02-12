const TELEGRAM_MAX_LENGTH = 4096

export function splitText(text: string, maxLength = TELEGRAM_MAX_LENGTH): readonly string[] {
  if (text.length <= maxLength) {
    return [text]
  }

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    let splitIndex = remaining.lastIndexOf('\n', maxLength)
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(' ', maxLength)
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = maxLength
    }

    chunks.push(remaining.slice(0, splitIndex))
    remaining = remaining.slice(splitIndex).trimStart()
  }

  return chunks
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
