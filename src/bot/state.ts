import type { ProjectInfo, AIModelSelection } from '../types/index.js'
import { env } from '../config/env.js'

interface UserState {
  selectedProject: ProjectInfo | null
  ai: AIModelSelection
}

const userStates = new Map<string, UserState>()

/** Build a session key that isolates forum topics */
export function sessionKey(chatId: number, threadId?: number): string {
  return threadId ? `${chatId}:${threadId}` : `${chatId}`
}

export function getUserState(chatId: number, threadId?: number): Readonly<UserState> {
  const key = sessionKey(chatId, threadId)
  let state = userStates.get(key)
  if (!state) {
    state = {
      selectedProject: null,
      ai: { backend: 'auto', model: env.DEFAULT_MODEL },
    }
    userStates.set(key, state)
  }
  return state
}

export function setUserProject(chatId: number, project: ProjectInfo, threadId?: number): void {
  const key = sessionKey(chatId, threadId)
  const state = getUserState(chatId, threadId)
  userStates.set(key, { ...state, selectedProject: project })
}

export function setUserAI(chatId: number, ai: AIModelSelection, threadId?: number): void {
  const key = sessionKey(chatId, threadId)
  const state = getUserState(chatId, threadId)
  userStates.set(key, { ...state, ai })
}

export function clearUserState(chatId: number, threadId?: number): void {
  const key = sessionKey(chatId, threadId)
  userStates.delete(key)
}
