import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { enqueue, clearQueue } from '../claude/queue.js'
import { cancelAnyRunning } from '../ai/registry.js'
import { clearAISession } from '../ai/session-store.js'
import { findProject, scanProjects } from '../config/projects.js'
import { setUserAI, setUserProject, getUserState } from '../bot/state.js'
import { acquireCommandLock, releaseCommandLock } from './command-lock.js'
import type { DashboardCommand } from './types.js'
import type { AIModelSelection } from '../ai/types.js'

const COMMANDS_FILE = join(process.cwd(), 'data', 'commands.json')
const POLL_INTERVAL_MS = 2_000
const MAX_COMMANDS_KEPT = 200

let timer: ReturnType<typeof setInterval> | null = null

function deriveBotId(): string {
  const envArg = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
  if (!envArg || envArg === '.env') return 'main'
  return envArg.replace('.env.', '')
}

async function readCommands(): Promise<DashboardCommand[]> {
  try {
    const raw = await readFile(COMMANDS_FILE, 'utf-8')
    return JSON.parse(raw) as DashboardCommand[]
  } catch {
    return []
  }
}

async function writeCommands(commands: readonly DashboardCommand[]): Promise<void> {
  await mkdir(join(process.cwd(), 'data'), { recursive: true })
  // Prune old completed/failed commands beyond limit
  const pruned = commands.length > MAX_COMMANDS_KEPT
    ? commands.slice(-MAX_COMMANDS_KEPT)
    : commands
  await writeFile(COMMANDS_FILE, JSON.stringify(pruned, null, 2), 'utf-8')
}

function claimCommand(
  commands: DashboardCommand[],
  cmd: DashboardCommand,
  botId: string,
): DashboardCommand[] {
  return commands.map((c) =>
    c.id === cmd.id
      ? { ...c, status: 'claimed' as const, claimedBy: botId }
      : c
  )
}

function completeCommand(
  commands: DashboardCommand[],
  cmdId: string,
  status: 'completed' | 'failed',
): DashboardCommand[] {
  return commands.map((c) =>
    c.id === cmdId ? { ...c, status } : c
  )
}

async function executeCommand(cmd: DashboardCommand): Promise<boolean> {
  const payload = cmd.payload

  switch (cmd.type) {
    case 'prompt': {
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
      if (!prompt) return false

      const projectName = typeof payload.project === 'string' ? payload.project : undefined
      const chatId = typeof payload.chatId === 'number' ? payload.chatId : 0
      const project = projectName
        ? findProject(projectName)
        : scanProjects()[0] ?? null

      if (!project) return false

      const state = getUserState(chatId)
      const sessionId = chatId === 0
        ? (await import('../ai/session-store.js')).getAISessionId(
            state.ai.backend === 'auto' ? 'claude' : state.ai.backend,
            project.path,
          )
        : null
      enqueue({
        chatId,
        prompt,
        project,
        ai: state.ai,
        sessionId,
        imagePaths: [],
        dashboardCommandId: chatId === 0 ? cmd.id : undefined,
      })
      return true
    }

    case 'cancel': {
      const projectName = typeof payload.project === 'string' ? payload.project : undefined
      if (projectName) {
        const project = findProject(projectName)
        if (project) {
          cancelAnyRunning(project.path)
          clearQueue(project.path)
        }
      } else {
        cancelAnyRunning()
        clearQueue()
      }
      return true
    }

    case 'select_project': {
      const projectName = typeof payload.project === 'string' ? payload.project : ''
      const chatId = typeof payload.chatId === 'number' ? payload.chatId : 0
      if (!projectName) return false
      const project = findProject(projectName)
      if (!project) return false
      setUserProject(chatId, project)
      return true
    }

    case 'switch_model': {
      const backend = typeof payload.backend === 'string' ? payload.backend : 'claude'
      const model = typeof payload.model === 'string' ? payload.model : 'sonnet'
      const chatId = typeof payload.chatId === 'number' ? payload.chatId : 0
      const ai: AIModelSelection = {
        backend: backend as AIModelSelection['backend'],
        model,
      }
      setUserAI(chatId, ai)
      return true
    }

    case 'new_session': {
      const projectName = typeof payload.project === 'string' ? payload.project : undefined
      const backend = typeof payload.backend === 'string' ? payload.backend : 'claude'
      if (projectName) {
        const project = findProject(projectName)
        if (project) {
          clearAISession(backend as AIModelSelection['backend'], project.path)
        }
      }
      return true
    }

    default:
      return false
  }
}

async function pollCommands(botId: string): Promise<void> {
  // Acquire file lock to prevent race conditions with other bots
  const locked = await acquireCommandLock(botId)
  if (!locked) return

  try {
    const commands = await readCommands()
    const pendingCommands = commands.filter((c) => {
      if (c.status !== 'pending') return false
      if (c.targetBot !== null && c.targetBot !== botId) return false
      // Dashboard commands (chatId === 0) must be processed by main bot
      // so response-broker events fire in the same process as dashboard server
      const isBrowserCmd = c.type === 'prompt'
        && (typeof c.payload.chatId !== 'number' || c.payload.chatId === 0)
      if (isBrowserCmd && botId !== 'main') return false
      return true
    })

    if (pendingCommands.length === 0) return

    // Claim and execute the first pending command
    const cmd = pendingCommands[0]
    const claimed = claimCommand(commands, cmd, botId)
    await writeCommands(claimed)

    try {
      const success = await executeCommand(cmd)
      const latest = await readCommands()
      const completed = completeCommand(latest, cmd.id, success ? 'completed' : 'failed')
      await writeCommands(completed)
    } catch (err) {
      console.error(`[command-reader] Execute failed for ${cmd.id}:`, err)
      const latest = await readCommands()
      const failed = completeCommand(latest, cmd.id, 'failed')
      await writeCommands(failed)
    }
  } finally {
    await releaseCommandLock()
  }
}

export function startCommandReader(): void {
  if (timer) return
  const botId = deriveBotId()

  timer = setInterval(() => {
    pollCommands(botId).catch((err) => {
      console.error('[command-reader] Poll failed:', err)
    })
  }, POLL_INTERVAL_MS)
}

export function stopCommandReader(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
