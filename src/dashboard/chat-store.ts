import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const CHAT_DIR = join(process.cwd(), 'data', 'chat')
const MAX_MESSAGES = 200

export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: string
  readonly botId: string | null
  readonly projectName: string
  readonly timestamp: number
  readonly commandId: string | null
}

function chatFilePath(project: string): string {
  const safeName = project.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(CHAT_DIR, `${safeName}.json`)
}

export async function readChatHistory(project: string): Promise<readonly ChatMessage[]> {
  try {
    const raw = await readFile(chatFilePath(project), 'utf-8')
    return JSON.parse(raw) as ChatMessage[]
  } catch {
    return []
  }
}

// Per-project write queue to prevent read-modify-write race conditions
const writeQueues = new Map<string, Promise<void>>()

export async function appendChatMessage(project: string, msg: ChatMessage): Promise<void> {
  const prev = writeQueues.get(project) ?? Promise.resolve()
  const next = prev.then(async () => {
    await mkdir(CHAT_DIR, { recursive: true })
    const existing = await readChatHistory(project)
    const updated = [...existing, msg]
    const pruned = updated.length > MAX_MESSAGES
      ? updated.slice(-MAX_MESSAGES)
      : updated
    await writeFile(chatFilePath(project), JSON.stringify(pruned, null, 2), 'utf-8')
  })
  writeQueues.set(project, next.catch(() => {}))
  return next
}
