import { useEffect, useRef } from 'react'
import { useDashboardStore } from '../stores/dashboard-store'
import { useChatStore } from '../stores/chat-store'
import type { WsMessage, ChatMessage } from '../types'

const RECONNECT_DELAY_MS = 3_000

export function useWebSocket(): void {
  const setBots = useDashboardStore((s) => s.setBots)
  const setWsConnected = useDashboardStore((s) => s.setWsConnected)
  const updateStream = useChatStore((s) => s.updateStream)
  const completeStream = useChatStore((s) => s.completeStream)
  const addSystemMessage = useChatStore((s) => s.addSystemMessage)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    function connect(): void {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${location.host}/ws`)
      wsRef.current = ws

      ws.onopen = () => {
        setWsConnected(true)
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as WsMessage

          switch (data.type) {
            case 'heartbeat':
              setBots(data.bots)
              break

            case 'response_chunk': {
              // Use projectName from server (resolves race condition)
              const project = data.projectName
                ?? useChatStore.getState().getCommandProject(data.commandId)
              if (project) {
                // Ensure command is registered for future events
                useChatStore.getState().registerCommand(data.commandId, project)
                updateStream(data.commandId, data.accumulated)
              }
              break
            }

            case 'response_complete': {
              const project = data.projectName
                ?? useChatStore.getState().getCommandProject(data.commandId)
              if (project) {
                const msg: ChatMessage = {
                  id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                  role: 'assistant',
                  content: data.text,
                  botId: data.botId,
                  projectName: project,
                  timestamp: Date.now(),
                  commandId: data.commandId,
                }
                completeStream(data.commandId, msg)
              }
              break
            }

            case 'response_error': {
              const project = data.projectName
                ?? useChatStore.getState().getCommandProject(data.commandId)
              if (project) {
                const msg: ChatMessage = {
                  id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                  role: 'system',
                  content: `Error: ${data.error}`,
                  botId: null,
                  projectName: project,
                  timestamp: Date.now(),
                  commandId: data.commandId,
                }
                addSystemMessage(data.commandId, msg)
              }
              break
            }
          }
        } catch {
          // ignore malformed messages
        }
      }

      ws.onclose = () => {
        setWsConnected(false)
        wsRef.current = null
        reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [setBots, setWsConnected, updateStream, completeStream, addSystemMessage])
}
