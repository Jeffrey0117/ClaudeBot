import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectInfo, AIModelSelection } from '../types/index.js'
import { env } from '../config/env.js'
import { resolveWorktreePath } from '../config/projects.js'

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
    const tmp = `${STATE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(all, null, 2))
    renameSync(tmp, STATE_FILE)
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
  // Auto-resolve worktree path for persisted states from before worktree was enabled
  if (state.selectedProject && env.WORKTREE_BRANCH) {
    const resolved = resolveWorktreePath(state.selectedProject)
    if (resolved.path !== state.selectedProject.path) {
      state = { ...state, selectedProject: resolved }
      userStates.set(key, state)
    }
  }
  return state
}

/** Hooks called before project switch to flush pending buffers. */
const projectSwitchHooks: Array<(chatId: number) => void> = []

/** Register a callback to run before project switch (used by OMB). */
export function onProjectSwitch(fn: (chatId: number) => void): void {
  projectSwitchHooks.push(fn)
}

export function setUserProject(chatId: number, project: ProjectInfo, threadId?: number): void {
  for (const hook of projectSwitchHooks) hook(chatId)
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
