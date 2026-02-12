import type { ClaudeModel, ProjectInfo } from '../types/index.js'
import { env } from '../config/env.js'

interface UserState {
  selectedProject: ProjectInfo | null
  model: ClaudeModel
}

const userStates = new Map<number, UserState>()

export function getUserState(chatId: number): Readonly<UserState> {
  let state = userStates.get(chatId)
  if (!state) {
    state = {
      selectedProject: null,
      model: env.DEFAULT_MODEL,
    }
    userStates.set(chatId, state)
  }
  return state
}

export function setUserProject(chatId: number, project: ProjectInfo): void {
  const state = getUserState(chatId)
  userStates.set(chatId, { ...state, selectedProject: project })
}

export function setUserModel(chatId: number, model: ClaudeModel): void {
  const state = getUserState(chatId)
  userStates.set(chatId, { ...state, model })
}

export function clearUserState(chatId: number): void {
  userStates.delete(chatId)
}
