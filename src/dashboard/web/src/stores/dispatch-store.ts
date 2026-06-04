import { create } from 'zustand'

export type DispatchStatus = 'running' | 'done' | 'error'

export interface DispatchTask {
  readonly commandId: string
  readonly label: string
  readonly status: DispatchStatus
  readonly output: string
  readonly startedAt: number
}

interface DispatchState {
  readonly tasks: Record<string, DispatchTask>
  start: (commandId: string, label: string) => void
  update: (commandId: string, output: string) => void
  complete: (commandId: string, output: string) => void
  fail: (commandId: string, error: string) => void
  has: (commandId: string) => boolean
  clear: () => void
}

/**
 * Tracks tasks dispatched from the 派發中心 by commandId, so the dispatch UI can
 * show live progress/output instead of fire-and-forget. Fed by the WebSocket
 * response broker events (see useWebSocket).
 */
export const useDispatchStore = create<DispatchState>((set, get) => ({
  tasks: {},
  start: (commandId, label) =>
    set((s) => ({
      tasks: {
        ...s.tasks,
        [commandId]: { commandId, label, status: 'running', output: '', startedAt: Date.now() },
      },
    })),
  update: (commandId, output) =>
    set((s) => (s.tasks[commandId]
      ? { tasks: { ...s.tasks, [commandId]: { ...s.tasks[commandId], output } } }
      : s)),
  complete: (commandId, output) =>
    set((s) => (s.tasks[commandId]
      ? { tasks: { ...s.tasks, [commandId]: { ...s.tasks[commandId], status: 'done', output } } }
      : s)),
  fail: (commandId, error) =>
    set((s) => (s.tasks[commandId]
      ? { tasks: { ...s.tasks, [commandId]: { ...s.tasks[commandId], status: 'error', output: error } } }
      : s)),
  has: (commandId) => Boolean(get().tasks[commandId]),
  clear: () => set({ tasks: {} }),
}))
