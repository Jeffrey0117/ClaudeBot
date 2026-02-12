import bcrypt from 'bcrypt'
import { env } from '../config/env.js'

const authenticatedChats = new Set<number>()

export async function login(chatId: number, password: string): Promise<boolean> {
  if (!env.ALLOWED_CHAT_IDS.includes(chatId)) {
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

export function logout(chatId: number): void {
  authenticatedChats.delete(chatId)
}

export function isAuthenticated(chatId: number): boolean {
  return authenticatedChats.has(chatId)
}

export function isChatAllowed(chatId: number): boolean {
  return env.ALLOWED_CHAT_IDS.includes(chatId)
}
