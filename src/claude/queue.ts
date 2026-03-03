import type { QueueItem } from '../types/index.js'
import { acquireLock, releaseLock, waitForLock } from './file-lock.js'

type ProcessFn = (item: QueueItem) => Promise<void>
type LockNotifyFn = (chatId: number, projectName: string, holder: string) => void

const queues = new Map<string, QueueItem[]>()
const processing = new Set<string>()
type CompletionFn = (projectPath: string) => void

let processFn: ProcessFn = async () => {}
let lockNotifyFn: LockNotifyFn = () => {}
let completionFn: CompletionFn = () => {}

export function setCompletionHook(fn: CompletionFn): void {
  completionFn = fn
}

export function setProcessor(fn: ProcessFn): void {
  processFn = fn
}

export function setLockNotify(fn: LockNotifyFn): void {
  lockNotifyFn = fn
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

/**
 * Merge queued prompts that accumulated while waiting for lock.
 * Same-chat items get combined into one compound prompt.
 */
function drainAndMerge(projectPath: string, first: QueueItem): QueueItem {
  const queue = queues.get(projectPath)
  if (!queue || queue.length === 0) return first

  // Collect all items from the same chatId
  const sameChatItems: QueueItem[] = []
  const remaining: QueueItem[] = []

  for (const item of queue) {
    if (item.chatId === first.chatId) {
      sameChatItems.push(item)
    } else {
      remaining.push(item)
    }
  }

  if (sameChatItems.length === 0) return first

  // Update queue with non-merged items
  if (remaining.length > 0) {
    queues.set(projectPath, remaining)
  } else {
    queues.delete(projectPath)
  }

  // Merge all images
  const allImages = [
    ...first.imagePaths,
    ...sameChatItems.flatMap((i) => [...i.imagePaths]),
  ]

  // Merge prompts into compound instruction
  const allPrompts = [first.prompt, ...sameChatItems.map((i) => i.prompt)]
  const mergedPrompt = allPrompts.length === 1
    ? allPrompts[0]
    : `以下是多個任務，請依序處理：\n\n${allPrompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`

  return {
    ...first,
    prompt: mergedPrompt,
    imagePaths: allImages,
  }
}

async function processNext(projectPath: string): Promise<void> {
  if (processing.has(projectPath)) return

  const queue = queues.get(projectPath)
  if (!queue || queue.length === 0) return

  processing.add(projectPath)
  const firstItem = queue.shift()!

  if (queue.length === 0) {
    queues.delete(projectPath)
  }

  try {
    // Task summary for lock file (so other bots can show what we're doing)
    const taskPreview = firstItem.prompt.slice(0, 60).replace(/\n/g, ' ')

    // Try to acquire cross-process file lock
    const acquired = await acquireLock(projectPath, taskPreview)

    if (!acquired) {
      // Another bot is working on this project — notify and wait
      let notified = false
      await waitForLock(projectPath, (holder) => {
        if (!notified) {
          notified = true
          lockNotifyFn(firstItem.chatId, firstItem.project.name, holder)
        }
      })
      // Re-acquire with our task info now that lock is free
      await acquireLock(projectPath, taskPreview)
    }

    // Lock acquired — merge any prompts that accumulated during wait
    const mergedItem = drainAndMerge(projectPath, firstItem)

    await processFn(mergedItem)
  } catch (error) {
    console.error(`Queue processing failed for chat ${firstItem.chatId}, project ${projectPath}:`, error)
  } finally {
    await releaseLock(projectPath)
    processing.delete(projectPath)
    completionFn(projectPath)
    processNext(projectPath)
  }
}
