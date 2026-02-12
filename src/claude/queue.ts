import type { QueueItem } from '../types/index.js'

type ProcessFn = (item: QueueItem) => Promise<void>

let processing = false
let processFn: ProcessFn = async () => {}
const items: QueueItem[] = []

export function setProcessor(fn: ProcessFn): void {
  processFn = fn
}

export function enqueue(item: QueueItem): void {
  items.push(item)
  processNext()
}

export function getQueueLength(): number {
  return items.length
}

export function isProcessing(): boolean {
  return processing
}

export function clearQueue(): readonly QueueItem[] {
  const cleared = [...items]
  items.length = 0
  return cleared
}

async function processNext(): Promise<void> {
  if (processing || items.length === 0) {
    return
  }

  processing = true
  const item = items.shift()!

  try {
    await processFn(item)
  } catch (error) {
    console.error(`Queue processing failed for chat ${item.chatId}:`, error)
  } finally {
    processing = false
    processNext()
  }
}
