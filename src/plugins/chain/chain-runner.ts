import type { Telegram } from 'telegraf'
import type { Chain, ChainRunResult, StepResult } from './chain-types.js'
import { createSession } from '../../bot/vision/browser-session.js'
import { runAgentLoop } from '../../bot/vision/web-agent.js'
import { executePipeService } from '../../utils/pipe-executor.js'
import { createFakeContext } from '../../utils/fake-context.js'
import { getCoreCommandHandler } from '../../bot/bot.js'
import { isPluginCommand, dispatchPluginCommand } from '../loader.js'
import type { BotContext } from '../../types/context.js'

const CHAIN_TOTAL_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const CMD_STEP_TIMEOUT_MS = 60_000

// Concurrency lock — one execution per chain name
const runningChains = new Set<string>()

function interpolate(text: string, prev: string, results: readonly StepResult[]): string {
  let out = text.replace(/\{\{prev\}\}/g, prev)
  out = out.replace(/\{\{step\.(\d+)\}\}/g, (_match, idx) => {
    const i = parseInt(idx, 10) - 1 // 1-indexed → 0-indexed
    return results[i]?.output ?? ''
  })
  return out
}

export async function runChain(
  chain: Chain,
  chatId: number,
  telegram: Telegram,
): Promise<ChainRunResult> {
  if (runningChains.has(chain.name)) {
    return {
      chainName: chain.name,
      success: false,
      stepResults: [],
      error: `Chain "${chain.name}" 正在執行中`,
    }
  }

  runningChains.add(chain.name)
  const startTime = Date.now()
  const stepResults: StepResult[] = []
  let prev = ''

  try {
    for (let i = 0; i < chain.steps.length; i++) {
      // Total timeout check
      if (Date.now() - startTime > CHAIN_TOTAL_TIMEOUT_MS) {
        return {
          chainName: chain.name,
          success: false,
          stepResults,
          error: `Chain 總執行時間超過 ${CHAIN_TOTAL_TIMEOUT_MS / 60_000} 分鐘`,
        }
      }

      const step = chain.steps[i]
      const instruction = interpolate(step.instruction, prev, stepResults)
      const stepStart = Date.now()

      // Status update
      await sendSafe(
        telegram, chatId,
        `⛓️ 步驟 ${i + 1}/${chain.steps.length}: ${step.type} ${instruction.slice(0, 60)}${instruction.length > 60 ? '...' : ''}`,
      )

      try {
        const output = await executeStep(step.type, instruction, chatId, telegram)
        const result: StepResult = {
          stepIndex: i,
          type: step.type,
          instruction,
          output,
          success: true,
          durationMs: Date.now() - stepStart,
        }
        stepResults.push(result)
        prev = output
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        stepResults.push({
          stepIndex: i,
          type: step.type,
          instruction,
          output: msg,
          success: false,
          durationMs: Date.now() - stepStart,
        })

        await sendSafe(telegram, chatId, `❌ Chain "${chain.name}" 步驟 ${i + 1} 失敗: ${msg}`)

        return {
          chainName: chain.name,
          success: false,
          stepResults,
          error: `步驟 ${i + 1} 失敗: ${msg}`,
        }
      }
    }

    return { chainName: chain.name, success: true, stepResults }
  } finally {
    runningChains.delete(chain.name)
  }
}

async function executeStep(
  type: string,
  instruction: string,
  chatId: number,
  telegram: Telegram,
): Promise<string> {
  switch (type) {
    case 'bv': {
      // Parse: first token is URL, rest is the instruction
      const spaceIdx = instruction.indexOf(' ')
      const url = spaceIdx === -1 ? instruction : instruction.slice(0, spaceIdx)
      const task = spaceIdx === -1 ? '看看這個頁面' : instruction.slice(spaceIdx + 1)

      const statusMsg = await telegram.sendMessage(chatId, '🌐 bv 啟動中...')
      const session = await createSession(chatId)
      const result = await runAgentLoop({
        chatId,
        url,
        instruction: task,
        statusMessageId: statusMsg.message_id,
        telegram,
        existingSession: session,
      })
      return result.summary
    }

    case 'pipe': {
      // Parse first token to decide routing
      const spaceIdx = instruction.indexOf(' ')
      const firstToken = spaceIdx === -1 ? instruction : instruction.slice(0, spaceIdx)
      const rest = spaceIdx === -1 ? '' : instruction.slice(spaceIdx + 1)

      // Known @pipe services: use service handler directly
      // e.g. "monitor.status", "health", "gateway.tools"
      const KNOWN_SERVICES = ['monitor', 'gateway', 'health', 'rawtxt']
      const dotIdx = firstToken.indexOf('.')
      const maybeService = dotIdx === -1 ? firstToken : firstToken.slice(0, dotIdx)

      if (KNOWN_SERVICES.includes(maybeService)) {
        const action = dotIdx === -1 ? '' : firstToken.slice(dotIdx + 1)
        return executePipeService(maybeService, action, rest)
      }

      // Otherwise treat as gateway tool call: "rawtxt_create_paste content"
      // Wrap plain text as JSON {content: text} for the tool
      const jsonArgs = rest
        ? (rest.startsWith('{') ? rest : JSON.stringify({ content: rest }))
        : ''
      return executePipeService('gateway', 'call', jsonArgs ? `${firstToken}, ${jsonArgs}` : firstToken)
    }

    case 'notify': {
      await telegram.sendMessage(chatId, instruction)
      return instruction
    }

    case 'wait': {
      const seconds = parseInt(instruction, 10)
      if (isNaN(seconds) || seconds <= 0) throw new Error(`無效的等待秒數: ${instruction}`)
      const capped = Math.min(seconds, 300) // cap at 5 minutes
      await new Promise((resolve) => setTimeout(resolve, capped * 1000))
      return `waited ${capped}s`
    }

    case 'cmd': {
      const cmdText = instruction.startsWith('/') ? instruction : `/${instruction}`
      const spaceIdx = cmdText.indexOf(' ')
      const cmdName = spaceIdx === -1 ? cmdText.slice(1) : cmdText.slice(1, spaceIdx)

      // Capture reply text so {{prev}} gets the actual output, not just "executed"
      const replies: string[] = []
      const fakeCtx = createFakeContext({
        chatId,
        commandText: cmdText,
        telegram: telegram as unknown as import('telegraf').Telegraf<BotContext>['telegram'],
      })
      const origReply = fakeCtx.reply.bind(fakeCtx)
      ;(fakeCtx as unknown as { reply: typeof origReply }).reply = async (text, extra) => {
        if (typeof text === 'string') replies.push(text)
        return origReply(text, extra)
      }

      const coreHandler = getCoreCommandHandler(cmdName)
      const handler = coreHandler
        ?? (isPluginCommand(cmdName) ? (c: BotContext) => dispatchPluginCommand(cmdName, c) : null)

      if (!handler) throw new Error(`未知指令: ${cmdText}`)

      await Promise.race([
        handler(fakeCtx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`指令逾時 (${CMD_STEP_TIMEOUT_MS / 1000}s)`)), CMD_STEP_TIMEOUT_MS),
        ),
      ])
      return replies.length > 0 ? replies.join('\n') : 'executed'
    }

    default:
      throw new Error(`未知步驟類型: ${type}`)
  }
}

async function sendSafe(telegram: Telegram, chatId: number, text: string): Promise<void> {
  try {
    await telegram.sendMessage(chatId, text)
  } catch {
    // ignore send failures
  }
}
