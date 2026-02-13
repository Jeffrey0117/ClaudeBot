import type { QueueItem } from '../types/index.js'

type ProcessFn = (item: QueueItem) => Promise<void>

const queues = new Map<string, QueueItem[]>()
const processing = new Set<string>()
let processFn: ProcessFn = async () => {}

export function setProcessor(fn: ProcessFn): void {
  processFn = fn
}

export function enqueue(item: QueueItem): void {
  const key = item.project.path
  const queue = queues.get(key) ?? []
  queue.push(item)
  queues.set(key, queue)
  processNext(key)
}

export function getQueueLength(projectPath?: string): number {
  if (projectPath) {
    return queues.get(projectPath)?.length ?? 0
  }
  let total = 0
  for (const q of queues.values()) {
    total += q.length
  }
  return total
}

export function isProcessing(projectPath?: string): boolean {
  if (projectPath) {
    return processing.has(projectPath)
  }
  return processing.size > 0
}

export function clearQueue(projectPath?: string): readonly QueueItem[] {
  if (projectPath) {
    const queue = queues.get(projectPath) ?? []
    const cleared = [...queue]
    queues.delete(projectPath)
    return cleared
  }
  const cleared: QueueItem[] = []
  for (const q of queues.values()) {
    cleared.push(...q)
  }
  queues.clear()
  return cleared
}

export function getActiveProjectPaths(): readonly string[] {
  return [...processing]
}

async function processNext(projectPath: string): Promise<void> {
  if (processing.has(projectPath)) return

  const queue = queues.get(projectPath)
  if (!queue || queue.length === 0) return

  processing.add(projectPath)
  const item = queue.shift()!

  if (queue.length === 0) {
    queues.delete(projectPath)
  }

  try {
    await processFn(item)
  } catch (error) {
    console.error(`Queue processing failed for chat ${item.chatId}, project ${projectPath}:`, error)
  } finally {
    processing.delete(projectPath)
    processNext(projectPath)
  }
}
