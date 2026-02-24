import { useState, useEffect, useRef } from 'react'
import { useDashboardStore } from '../stores/dashboard-store'
import { useChatStore } from '../stores/chat-store'
import { useTranslation } from '../hooks/useTranslation'
import { apiFetch, apiPost } from '../hooks/useApi'
import { ChannelHeader } from './ChannelHeader'
import { ChatBubble } from './ChatBubble'
import type { ChatMessage, DashboardCommand } from '../types'

export function ChatPanel() {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingCommandIds, setPendingCommandIds] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const prevChannelRef = useRef<string | null>(null)

  const addCommand = useDashboardStore((s) => s.addCommand)
  const draftPrompt = useDashboardStore((s) => s.draftPrompt)
  const setDraftPrompt = useDashboardStore((s) => s.setDraftPrompt)
  const projects = useDashboardStore((s) => s.projects)

  const selectedChannel = useChatStore((s) => s.selectedChannel)
  const setChannel = useChatStore((s) => s.setChannel)
  const targetBot = useChatStore((s) => s.targetBot)
  const messages = useChatStore((s) => s.messages)
  const activeStreams = useChatStore((s) => s.activeStreams)
  const addUserMessage = useChatStore((s) => s.addUserMessage)
  const registerCommand = useChatStore((s) => s.registerCommand)
  const loadHistory = useChatStore((s) => s.loadHistory)

  // Auto-select first project as channel
  useEffect(() => {
    if (!selectedChannel && projects.length > 0) {
      setChannel(projects[0].name)
    }
  }, [selectedChannel, projects, setChannel])

  // Load chat history when channel changes + show switch notification
  useEffect(() => {
    if (!selectedChannel) return

    // Show channel switch notification
    if (prevChannelRef.current !== null && prevChannelRef.current !== selectedChannel) {
      const sysMsg: ChatMessage = {
        id: `sys_${Date.now()}`,
        role: 'system',
        content: `Switched to #${selectedChannel}`,
        botId: null,
        projectName: selectedChannel,
        timestamp: Date.now(),
        commandId: null,
      }
      addUserMessage(sysMsg)
    }
    prevChannelRef.current = selectedChannel

    apiFetch<{ messages: readonly ChatMessage[] }>(`/api/chat/${encodeURIComponent(selectedChannel)}`)
      .then((data) => {
        if (data.messages.length > 0) {
          loadHistory(selectedChannel, data.messages)
        }
      })
      .catch(() => {})
  }, [selectedChannel, loadHistory, addUserMessage])

  // Pick up draft from templates
  useEffect(() => {
    if (draftPrompt) {
      setInput(draftPrompt)
      setDraftPrompt('')
      inputRef.current?.focus()
    }
  }, [draftPrompt, setDraftPrompt])

  // Auto-scroll to bottom
  const channelMessages = selectedChannel ? (messages[selectedChannel] ?? []) : []
  const channelStreams = Object.entries(activeStreams).filter(
    ([, s]) => s.projectName === selectedChannel
  )

  // Clear pending when stream starts or completes
  useEffect(() => {
    const streamingIds = new Set(channelStreams.map(([id]) => id))
    const completedIds = channelMessages
      .filter((m) => m.commandId && m.role === 'assistant')
      .map((m) => m.commandId!)
    setPendingCommandIds((prev) => {
      const next = new Set(prev)
      for (const id of streamingIds) next.delete(id)
      for (const id of completedIds) next.delete(id)
      return next.size === prev.size ? prev : next
    })
  }, [channelStreams, channelMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [channelMessages.length, channelStreams.length])

  const handleSend = async () => {
    const prompt = input.trim()
    if (!prompt || sending || !selectedChannel) return

    setSending(true)
    setError(null)
    try {
      const data = await apiPost<{ command: DashboardCommand }>('/api/commands', {
        type: 'prompt',
        targetBot: targetBot ?? null,
        payload: { prompt, project: selectedChannel },
      })
      addCommand(data.command)
      registerCommand(data.command.id, selectedChannel)

      const userMsg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: prompt,
        botId: null,
        projectName: selectedChannel,
        timestamp: Date.now(),
        commandId: data.command.id,
      }
      addUserMessage(userMsg)
      setPendingCommandIds((prev) => new Set([...prev, data.command.id]))
      setInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!selectedChannel) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
      }}>
        {t('chat.selectProject')}
      </div>
    )
  }

  // Pending commands that haven't started streaming yet
  const waitingCount = [...pendingCommandIds].filter(
    (id) => !channelStreams.some(([cmdId]) => cmdId === id)
  ).length

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    }}>
      <ChannelHeader />

      {/* Messages area */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '8px 0',
        minHeight: 0,
      }}>
        {channelMessages.length === 0 && channelStreams.length === 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-muted)',
            fontSize: '14px',
          }}>
            {t('chat.noMessages')}
          </div>
        )}

        {channelMessages.map((msg) => (
          <ChatBubble key={msg.id} message={msg} />
        ))}

        {/* Active streams */}
        {channelStreams.map(([cmdId, stream]) => (
          <ChatBubble
            key={`stream-${cmdId}`}
            message={{
              id: `stream-${cmdId}`,
              role: 'assistant',
              content: stream.accumulated,
              botId: null,
              projectName: stream.projectName,
              timestamp: Date.now(),
              commandId: cmdId,
            }}
            streaming
            streamText={stream.accumulated}
          />
        ))}

        {/* Waiting indicator */}
        {waitingCount > 0 && channelStreams.length === 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            padding: '4px 16px',
          }}>
            <div style={{
              padding: '10px 14px',
              borderRadius: '16px 16px 16px 4px',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              fontSize: '14px',
              color: 'var(--text-muted)',
            }}>
              <span className="blink-cursor" style={{ fontSize: '16px' }}>{'\u2026'}</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          padding: '8px 16px',
          background: 'var(--accent-red)',
          color: '#fff',
          fontSize: '13px',
          cursor: 'pointer',
        }} onClick={() => setError(null)}>
          {error} (click to dismiss)
        </div>
      )}

      {/* Input area */}
      <div style={{
        display: 'flex',
        gap: '8px',
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
      }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('command.placeholder')}
          disabled={sending}
          rows={1}
          style={{
            flex: 1,
            padding: '10px 14px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-primary)',
            fontSize: '14px',
            outline: 'none',
            resize: 'none',
            fontFamily: 'inherit',
            lineHeight: '1.4',
          }}
        />
        <button
          onClick={handleSend}
          disabled={sending || !input.trim()}
          style={{
            padding: '10px 20px',
            background: sending ? 'var(--bg-hover)' : 'var(--accent-blue)',
            border: 'none',
            borderRadius: 'var(--radius)',
            color: '#fff',
            fontSize: '14px',
            fontWeight: 600,
            cursor: sending ? 'not-allowed' : 'pointer',
            opacity: !input.trim() ? 0.5 : 1,
            alignSelf: 'flex-end',
          }}
        >
          {sending ? t('command.sending') : '\u2192'}
        </button>
      </div>
    </div>
  )
}
