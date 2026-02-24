import { create } from 'zustand'
import type { BotHeartbeat, DashboardCommand, ProjectInfo } from '../types'

export type ActiveView = 'dashboard' | 'chat'

interface DashboardState {
  readonly bots: readonly BotHeartbeat[]
  readonly projects: readonly ProjectInfo[]
  readonly commands: readonly DashboardCommand[]
  readonly wsConnected: boolean
  readonly selectedBotId: string | null
  readonly selectedProjectPath: string | null
  readonly draftPrompt: string
  readonly activeView: ActiveView

  setBots: (bots: readonly BotHeartbeat[]) => void
  setProjects: (projects: readonly ProjectInfo[]) => void
  setCommands: (commands: readonly DashboardCommand[]) => void
  addCommand: (command: DashboardCommand) => void
  setWsConnected: (connected: boolean) => void
  setSelectedBotId: (botId: string | null) => void
  setSelectedProjectPath: (path: string | null) => void
  setDraftPrompt: (prompt: string) => void
  setActiveView: (view: ActiveView) => void
}

export const useDashboardStore = create<DashboardState>((set) => ({
  bots: [],
  projects: [],
  commands: [],
  wsConnected: false,
  selectedBotId: null,
  selectedProjectPath: null,
  draftPrompt: '',
  activeView: 'chat',

  setBots: (bots) => set({ bots }),
  setProjects: (projects) => set({ projects }),
  setCommands: (commands) => set({ commands }),
  addCommand: (command) =>
    set((state) => ({ commands: [...state.commands, command] })),
  setWsConnected: (wsConnected) => set({ wsConnected }),
  setSelectedBotId: (selectedBotId) => set({ selectedBotId }),
  setSelectedProjectPath: (selectedProjectPath) => set({ selectedProjectPath }),
  setDraftPrompt: (draftPrompt) => set({ draftPrompt }),
  setActiveView: (activeView) => set({ activeView }),
}))
