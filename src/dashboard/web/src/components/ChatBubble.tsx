import type { ChatMessage } from '../types'

interface ChatBubbleProps {
  readonly message: ChatMessage
  readonly streaming?: boolean
  readonly streamText?: string
}

export function ChatBubble({ message, streaming, streamText }: ChatBubbleProps) {
  const content = streaming ? (streamText ?? '') : message.content
  const time = new Date(message.timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  })

  if (message.role === 'system') {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        padding: '8px 16px',
      }}>
        <span style={{
          fontSize: '12px',
          color: 'var(--text-muted)',
          background: 'var(--bg-hover)',
          padding: '4px 12px',
          borderRadius: '12px',
        }}>
          {content}
        </span>
      </div>
    )
  }

  const isUser = message.role === 'user'

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      padding: '4px 16px',
    }}>
      {!isUser && message.botId && (
        <span style={{
          fontSize: '11px',
          color: 'var(--accent-blue)',
          fontWeight: 600,
          marginBottom: '2px',
          marginLeft: '12px',
        }}>
          @{message.botId}
        </span>
      )}
      <div style={{
        maxWidth: '75%',
        padding: '10px 14px',
        borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        background: isUser ? 'var(--accent-blue)' : 'var(--bg-card)',
        color: isUser ? '#fff' : 'var(--text-primary)',
        fontSize: '14px',
        lineHeight: '1.5',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
        border: isUser ? 'none' : '1px solid var(--border)',
      }}>
        <FormattedContent text={content} />
        {streaming && <span className="blink-cursor">{'\u258C'}</span>}
      </div>
      <span style={{
        fontSize: '10px',
        color: 'var(--text-muted)',
        marginTop: '2px',
        padding: '0 12px',
      }}>
        {time}
      </span>
    </div>
  )
}

function FormattedContent({ text }: { readonly text: string }) {
  if (!text) return null

  // Simple markdown: **bold**, `code`, ```codeblock```
  const parts: React.ReactNode[] = []
  let remaining = text
  let key = 0

  while (remaining.length > 0) {
    // Code block
    const cbMatch = remaining.match(/^```(?:\w*\n)?([\s\S]*?)```/)
    if (cbMatch) {
      parts.push(
        <pre key={key++} style={{
          background: 'var(--bg-secondary)',
          padding: '8px 10px',
          borderRadius: '6px',
          fontSize: '12px',
          fontFamily: 'monospace',
          overflow: 'auto',
          margin: '4px 0',
          whiteSpace: 'pre-wrap',
        }}>
          {cbMatch[1]}
        </pre>
      )
      remaining = remaining.slice(cbMatch[0].length)
      continue
    }

    // Inline code
    const icMatch = remaining.match(/^`([^`]+)`/)
    if (icMatch) {
      parts.push(
        <code key={key++} style={{
          background: 'var(--bg-secondary)',
          padding: '1px 4px',
          borderRadius: '3px',
          fontSize: '13px',
          fontFamily: 'monospace',
        }}>
          {icMatch[1]}
        </code>
      )
      remaining = remaining.slice(icMatch[0].length)
      continue
    }

    // Bold
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/)
    if (boldMatch) {
      parts.push(<strong key={key++}>{boldMatch[1]}</strong>)
      remaining = remaining.slice(boldMatch[0].length)
      continue
    }

    // Plain text until next special char
    const nextSpecial = remaining.search(/[`*]/)
    if (nextSpecial === -1) {
      parts.push(remaining)
      break
    }
    if (nextSpecial === 0) {
      // Not a valid pattern, consume one char
      parts.push(remaining[0])
      remaining = remaining.slice(1)
    } else {
      parts.push(remaining.slice(0, nextSpecial))
      remaining = remaining.slice(nextSpecial)
    }
  }

  return <>{parts}</>
}
