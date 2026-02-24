import { create } from 'zustand'
import type { ChatMessage } from '../types'

interface StreamState {
  readonly accumulated: string
  readonly projectName: string
}

interface ChatState {
  readonly messages: Record<string, readonly ChatMessage[]>
  readonly activeStreams: Record<string, StreamState>
  readonly commandProjectMap: Record<string, string>
  readonly selectedChannel: string | null
  readonly targetBot: string | null

  setChannel: (name: string | null) => void
  setTargetBot: (botId: string | null) => void
  addUserMessage: (msg: ChatMessage) => void
  loadHistory: (project: string, msgs: readonly ChatMessage[]) => void
  registerCommand: (commandId: string, projectName: string) => void
  updateStream: (commandId: string, accumulated: string) => void
  completeStream: (commandId: string, msg: ChatMessage) => void
  addSystemMessage: (commandId: string, msg: ChatMessage) => void
  getCommandProject: (commandId: string) => string | null
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: {},
  activeStreams: {},
  commandProjectMap: {},
  selectedChannel: null,
  targetBot: null,

  setChannel: (selectedChannel) => set({ selectedChannel }),
  setTargetBot: (targetBot) => set({ targetBot }),

  addUserMessage: (msg) =>
    set((state) => {
      const key = msg.projectName
      const existing = state.messages[key] ?? []
      return { messages: { ...state.messages, [key]: [...existing, msg] } }
    }),

  loadHistory: (project, msgs) =>
    set((state) => ({
      messages: { ...state.messages, [project]: msgs },
    })),

  registerCommand: (commandId, projectName) =>
    set((state) => ({
      commandProjectMap: { ...state.commandProjectMap, [commandId]: projectName },
    })),

  updateStream: (commandId, accumulated) =>
    set((state) => {
      const projectName = state.commandProjectMap[commandId]
      if (!projectName) return state
      return {
        activeStreams: {
          ...state.activeStreams,
          [commandId]: { accumulated, projectName },
        },
      }
    }),

  completeStream: (commandId, msg) =>
    set((state) => {
      const { [commandId]: _s, ...restStreams } = state.activeStreams
      const { [commandId]: _p, ...restMap } = state.commandProjectMap
      const key = msg.projectName
      const existing = state.messages[key] ?? []
      return {
        activeStreams: restStreams,
        commandProjectMap: restMap,
        messages: { ...state.messages, [key]: [...existing, msg] },
      }
    }),

  addSystemMessage: (commandId, msg) =>
    set((state) => {
      const { [commandId]: _s, ...restStreams } = state.activeStreams
      const { [commandId]: _p, ...restMap } = state.commandProjectMap
      const key = msg.projectName
      const existing = state.messages[key] ?? []
      return {
        activeStreams: restStreams,
        commandProjectMap: restMap,
        messages: { ...state.messages, [key]: [...existing, msg] },
      }
    }),

  getCommandProject: (commandId) => get().commandProjectMap[commandId] ?? null,
}))
