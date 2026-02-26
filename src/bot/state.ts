import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectInfo, AIModelSelection } from '../types/index.js'
import { env } from '../config/env.js'

/** Short bot identifier from token (last 6 chars) for state isolation. */
const BOT_ID = env.BOT_TOKEN.slice(-6)

const STATE_FILE = join(process.cwd(), '.user-states.json')

interface UserState {
  selectedProject: ProjectInfo | null
  ai: AIModelSelection
}

type PersistedStates = Record<string, UserState>

function loadAll(): PersistedStates {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function loadStates(): Map<string, UserState> {
  const all = loadAll()
  const prefix = `${BOT_ID}:`
  const map = new Map<string, UserState>()
  for (const [key, state] of Object.entries(all)) {
    if (key.startsWith(prefix)) {
      map.set(key.slice(prefix.length), state)
    }
  }
  return map
}

function saveStates(): void {
  // Merge with other bots' states already on disk
  const all = loadAll()
  const prefix = `${BOT_ID}:`

  // Remove this bot's old entries
  for (const key of Object.keys(all)) {
    if (key.startsWith(prefix)) delete all[key]
  }

  // Write current states
  for (const [key, state] of userStates) {
    all[`${prefix}${key}`] = state
  }

  try {
    writeFileSync(STATE_FILE, JSON.stringify(all, null, 2))
  } catch (err) {
    console.error('[state] failed to save:', err)
  }
}

const userStates = loadStates()

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
  saveStates()
}

export function setUserAI(chatId: number, ai: AIModelSelection, threadId?: number): void {
  const key = sessionKey(chatId, threadId)
  const state = getUserState(chatId, threadId)
  userStates.set(key, { ...state, ai })
  saveStates()
}

/** Return all persisted user states for this bot instance (for restart notifications). */
export function getActiveUserStates(): ReadonlyMap<string, Readonly<UserState>> {
  return userStates
}

export function clearUserState(chatId: number, threadId?: number): void {
  const key = sessionKey(chatId, threadId)
  userStates.delete(key)
  saveStates()
}
