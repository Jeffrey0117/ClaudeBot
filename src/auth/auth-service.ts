import bcrypt from 'bcrypt'
import { env } from '../config/env.js'
import { isVirtualChat } from '../remote/virtual-chat-store.js'

const authenticatedChats = new Set<number>()

export async function login(chatId: number, password: string): Promise<boolean> {
  if (!isChatAllowed(chatId)) {
    return false
  }

  const match = env.LOGIN_PASSWORD_HASH
    ? await bcrypt.compare(password, env.LOGIN_PASSWORD_HASH)
    : password === env.LOGIN_PASSWORD

  if (match) {
    authenticatedChats.add(chatId)
    return true
  }

  return false
}

export function autoAuth(chatId: number): boolean {
  if (!isChatAllowed(chatId)) return false
  authenticatedChats.add(chatId)
  return true
}

export function logout(chatId: number): void {
  authenticatedChats.delete(chatId)
}

export function isAuthenticated(chatId: number): boolean {
  return authenticatedChats.has(chatId)
}

export function isChatAllowed(chatId: number): boolean {
  if (isVirtualChat(chatId)) return true // Electron virtual user (paired via code)
  return env.ALLOWED_CHAT_IDS.includes(chatId) || env.REMOTE_CHAT_IDS.includes(chatId)
}

/** Remote-only users: can only use pairing, blocked from local projects/admin commands */
export function isRemoteOnly(chatId: number): boolean {
  if (isVirtualChat(chatId)) return true // Electron = remote-only
  return env.REMOTE_CHAT_IDS.includes(chatId) && !env.ALLOWED_CHAT_IDS.includes(chatId)
}
