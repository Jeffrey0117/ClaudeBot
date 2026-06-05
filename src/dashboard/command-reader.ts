import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { enqueue, clearQueue } from '../claude/queue.js'
import { cancelAnyRunning } from '../ai/registry.js'
import { clearAISession } from '../ai/session-store.js'
import { findProject, scanProjects } from '../config/projects.js'
import { setUserAI, setUserProject, getUserState, setActiveMachine } from '../bot/state.js'
import { acquireCommandLock, releaseCommandLock } from './command-lock.js'
import type { DashboardCommand } from './types.js'
import type { AIModelSelection } from '../ai/types.js'

const COMMANDS_FILE = join(process.cwd(), 'data', 'commands.json')
const POLL_INTERVAL_MS = 2_000
const MAX_COMMANDS_KEPT = 200

let timer: ReturnType<typeof setInterval> | null = null

function deriveBotId(): string {
  const envArg = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
  if (!envArg || envArg === '.env') return 'bot1'
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

    case 'dispatch_remote': {
      // Fan-out a task to a specific remote machine from the dashboard.
      // Reuses the proven virtual-chat path: bind a stable virtual chat to the
      // machine's pairing code so the runner attaches that machine's MCP tools,
      // then enqueue the task as a normal remote Claude session.
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
      const code = typeof payload.code === 'string' ? payload.code : ''
      const label = typeof payload.label === 'string' ? payload.label : ''
      if (!prompt || !code || !label) return false

      // Fast path: deterministic intent (open app / play URL in a browser) →
      // run it directly on the machine, skip the model. Reliable + instant.
      const { detectRemoteIntent } = await import('../utils/remote-intent.js')
      const intent = detectRemoteIntent(prompt)
      if (intent) {
        const { remoteToolCall } = await import('../remote/relay-client.js')
        const { emitResponseComplete, emitResponseError } = await import('./response-broker.js')
        try {
          if (intent.js) {
            await remoteToolCall(code, 'remote_browser_eval', { js: intent.js }, 90_000)
            if (intent.thenJs) {
              const then2 = intent.thenJs
              void (async () => {
                await new Promise((r) => setTimeout(r, 4000))
                await remoteToolCall(code, 'remote_browser_eval', { js: then2 }, 60_000).catch(() => {})
              })()
            }
          } else if (intent.spawnArgs) {
            // GUI launch — detached, returns instantly (remote_execute_command hangs on GUI → false timeout).
            await remoteToolCall(code, 'remote_spawn_detached', { command: 'cmd', args: JSON.stringify(intent.spawnArgs) }, 15_000)
          } else if (intent.command) {
            await remoteToolCall(code, 'remote_execute_command', { command: intent.command }, 30_000)
          }
          emitResponseComplete(cmd.id, `${intent.reply}（直接執行，未經 AI）`, label, 0, 0)
        } catch (err) {
          emitResponseError(cmd.id, `${intent.kind} 失敗: ${err instanceof Error ? err.message : String(err)}`)
        }
        return true
      }

      const { getOrCreateVirtualChat } = await import('../remote/virtual-chat-store.js')
      const { autoAuth } = await import('../auth/auth-service.js')
      const { remoteProjectPath } = await import('../remote/pairing-store.js')
      const { getAISessionId } = await import('../ai/session-store.js')

      const vchatId = getOrCreateVirtualChat(`dashboard-machine:${code}`, code)
      autoAuth(vchatId)
      setActiveMachine(vchatId, label)

      const project = { name: 'remote', path: remoteProjectPath(label) }
      setUserProject(vchatId, project)

      const state = getUserState(vchatId)
      const sessionId = getAISessionId(
        state.ai.backend === 'auto' ? 'claude' : state.ai.backend,
        project.path,
      )
      enqueue({
        chatId: vchatId,
        prompt,
        project,
        ai: state.ai,
        sessionId,
        imagePaths: [],
        // Broker the dispatched task's response back to the dashboard so the
        // dispatch center can show progress/output instead of fire-and-forget.
        dashboardCommandId: cmd.id,
      })
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
  // --- Phase 1: claim ALL pending commands under the lock, then release it ---
  // (We must NOT hold the lock during execution — a single dispatch can await a
  //  remote tool for up to 90s, and that would serialize fan-out to N machines
  //  and block sibling commands. Claiming is quick; execution runs lock-free.)
  const locked = await acquireCommandLock(botId)
  if (!locked) return

  let toRun: DashboardCommand[] = []
  try {
    const commands = await readCommands()
    const pendingCommands = commands.filter((c) => {
      if (c.status !== 'pending') return false
      if (c.targetBot !== null && c.targetBot !== botId) return false
      // Dashboard commands (chatId === 0) must be processed by the main bot
      // so response-broker events fire in the same process as dashboard server.
      const isBrowserCmd = c.type === 'prompt'
        && (typeof c.payload.chatId !== 'number' || c.payload.chatId === 0)
      const envArg = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
      const isMainBot = !envArg || envArg === '.env'
      if (isBrowserCmd && !isMainBot) return false
      return true
    })

    if (pendingCommands.length === 0) return

    let claimed = commands
    for (const c of pendingCommands) claimed = claimCommand(claimed, c, botId)
    await writeCommands(claimed)
    toRun = pendingCommands
  } finally {
    await releaseCommandLock()
  }

  // --- Phase 2: execute all claimed commands CONCURRENTLY (no lock held) ---
  const results = await Promise.all(
    toRun.map(async (cmd) => {
      try {
        return { id: cmd.id, status: (await executeCommand(cmd)) ? 'completed' as const : 'failed' as const }
      } catch (err) {
        console.error(`[command-reader] Execute failed for ${cmd.id}:`, err)
        return { id: cmd.id, status: 'failed' as const }
      }
    }),
  )

  // --- Phase 3: write all final statuses once, back under the lock ---
  let gotLock = await acquireCommandLock(botId)
  if (!gotLock) { await new Promise((r) => setTimeout(r, 250)); gotLock = await acquireCommandLock(botId) }
  try {
    let latest = await readCommands()
    for (const r of results) latest = completeCommand(latest, r.id, r.status)
    await writeCommands(latest)
  } finally {
    if (gotLock) await releaseCommandLock()
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
