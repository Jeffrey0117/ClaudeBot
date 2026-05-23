/**
 * Screen Agent — operates on the user's actual desktop screen.
 * No CDP, no browser restart. Just screenshot → Gemini → click/type → repeat.
 *
 * Used as fallback when Chrome CDP is not available:
 * user already has Chrome open with IG → /bv 點讚第一則 → agent clicks on screen.
 */

import type { Telegram } from 'telegraf'
import { callGeminiApi, type AgentStep, type AgentAction } from '../../ai/gemini-agent-vision.js'
import { env } from '../../config/env.js'
import {
  captureScreen,
  readScreenshotBase64,
  clickScreen,
  typeScreen,
  pressScreen,
  scrollScreen,
  type ScreenCapture,
} from './screen-control.js'
import { updateAgentStep } from './web-agent-store.js'

const MAX_STEPS = 15
const TOTAL_TIMEOUT_MS = 180_000
const SETTLE_DELAY_MS = 1500

// --- JSON schema (restricted to screen-compatible actions) ---

function buildScreenActionSchema(imageW: number, imageH: number) {
  return {
    type: 'OBJECT' as const,
    properties: {
      thought: { type: 'STRING' as const, description: 'Your reasoning about what you see on screen' },
      action: {
        type: 'OBJECT' as const,
        properties: {
          type: { type: 'STRING' as const, enum: ['click_xy', 'fill', 'press', 'scroll', 'done'] },
          text: { type: 'STRING' as const, description: 'Text to type (fill), key name (press), or direction (scroll: "up"/"down")' },
          x: { type: 'NUMBER' as const, description: `X pixel coordinate for click_xy (0-${imageW})` },
          y: { type: 'NUMBER' as const, description: `Y pixel coordinate for click_xy (0-${imageH})` },
        },
        required: ['type'],
      },
      done: { type: 'BOOLEAN' as const, description: 'true if the task is complete' },
    },
    required: ['thought', 'action', 'done'],
  }
}

// --- Prompt ---

function buildScreenPrompt(
  instruction: string,
  history: readonly AgentStep[],
  imageW: number,
  imageH: number,
): string {
  const historyText = history.length > 0
    ? '\n\nPrevious steps:\n' + history.map((s, i) =>
      `Step ${i + 1}: ${s.thought} → ${s.action.type}` +
      (s.action.x != null ? ` at (${s.action.x},${s.action.y})` : '') +
      (s.action.text ? ` "${s.action.text}"` : ''),
    ).join('\n')
    : ''

  return (
    `You are a screen automation agent. The screenshot is ${imageW}x${imageH} pixels.\n` +
    'The screenshot shows the full monitor. Chrome browser is maximized on it.\n' +
    'The top ~60-80px shows Chrome tabs and address bar — do NOT click there.\n' +
    'The bottom ~40px may show the Windows taskbar — do NOT click there.\n' +
    'Focus ONLY on the webpage content area in between.\n\n' +
    'Your task: ' + instruction + '\n' +
    historyText + '\n\n' +
    'Available actions:\n' +
    '- click_xy: Click at (x, y) screen coordinates. Specify x and y.\n' +
    '- fill: Type text via keyboard. FIRST use click_xy to focus the input field, THEN use fill.\n' +
    '- press: Press a key (Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, etc.)\n' +
    '- scroll: Scroll the page. Set text to "up" or "down".\n' +
    '- done: Task complete. Set done=true and describe the result in thought.\n\n' +
    'Rules:\n' +
    '- Look carefully at the screenshot to find UI elements\n' +
    '- Click precisely at the CENTER of the target element\n' +
    '- The coordinates are in screen pixels (0,0 = top-left corner)\n' +
    '- After clicking an input field, use fill to type text\n' +
    '- Wait is handled automatically between steps — just proceed to the next action\n' +
    '- Do NOT scroll unless you have already tried clicking and failed at least 2 times. If you can see post content, the buttons are already visible.\n' +
    '- If the task is already done (e.g., heart is filled/red = already liked), set done=true immediately\n' +
    '- Do NOT attempt to log in unless the user explicitly provides credentials\n\n' +
    'Instagram layout guide (CRITICAL — read carefully):\n' +
    '- Below each post image/video, there is a ROW of small icon buttons (~20-30px tall)\n' +
    '- The icon order LEFT to RIGHT is: Heart ♡ (like) | Speech bubble (comment) | Paper plane (share) ... and Bookmark on the far right\n' +
    '- The HEART icon is ALWAYS the LEFTMOST icon in this row, at the bottom-left corner of the post image\n' +
    '- If the heart appears FILLED/RED (❤️), the post is already liked\n' +
    '- "第一則貼文" (first post) = the first post visible on the feed, usually already on screen — do NOT scroll\n' +
    '- To like: find the row of icons below the first post image, click the LEFTMOST icon (heart)\n' +
    '- The icons are very small SVGs. Look for a row of tiny shapes below the image. The heart outline is the first one.\n' +
    '- If you see the post image but cannot pinpoint the heart, click approximately 30px below the bottom-left corner of the image\n\n' +
    'Other UI patterns:\n' +
    '- Windows file dialog: type the full file path in the "File name" field at the bottom, then press Enter\n' +
    '- After clicking a small icon, wait for the next screenshot to confirm it worked before proceeding\n' +
    '- If coordinates seem wrong, adjust by 10-20px and try again rather than scrolling'
  )
}

// --- Types ---

export interface ScreenAgentOptions {
  readonly chatId: number
  readonly instruction: string
  readonly statusMessageId: number
  readonly telegram: Telegram
  readonly abortSignal?: AbortSignal
}

export interface ScreenAgentResult {
  readonly steps: readonly AgentStep[]
  readonly finalScreenshot?: string
  readonly success: boolean
  readonly summary: string
}

// --- Agent loop ---

export async function runScreenAgent(options: ScreenAgentOptions): Promise<ScreenAgentResult> {
  const { chatId, instruction, statusMessageId, telegram, abortSignal } = options

  if (!env.GEMINI_API_KEY) {
    return { steps: [], success: false, summary: 'GEMINI_API_KEY 未設定' }
  }

  const steps: AgentStep[] = []
  const startTime = Date.now()
  let finalScreenshot: string | undefined
  let consecutiveFailures = 0

  for (let i = 0; i < MAX_STEPS; i++) {
    if (abortSignal?.aborted) {
      return buildResult(steps, finalScreenshot, false, '已取消')
    }
    if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
      return buildResult(steps, finalScreenshot, false, `超時 (${TOTAL_TIMEOUT_MS / 1000}s)`)
    }

    updateAgentStep(chatId, i + 1)
    await updateStatus(telegram, chatId, statusMessageId, `🖥️ 步驟 ${i + 1}/${MAX_STEPS}: 截圖分析中...`)

    // 1. Capture screen
    const capture = await captureScreen()
    const screenshot = await readScreenshotBase64(capture.filePath)
    finalScreenshot = screenshot

    // 2. Ask Gemini (use actual capture dimensions — no resize, 1:1 coordinates)
    const imageW = capture.clientWidth
    const imageH = capture.clientHeight
    const prompt = buildScreenPrompt(instruction, steps, imageW, imageH)
    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/png', data: screenshot } },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: buildScreenActionSchema(imageW, imageH),
        maxOutputTokens: 2048,
      },
    }

    const result = await callGeminiApi(body)
    if (result.error) {
      return buildResult(steps, finalScreenshot, false, result.error)
    }

    let step: AgentStep
    try {
      step = JSON.parse(result.text) as AgentStep
    } catch {
      // Gemini sometimes wraps JSON in markdown or adds extra text — extract it
      const jsonMatch = result.text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          step = JSON.parse(jsonMatch[0]) as AgentStep
        } catch {
          return buildResult(steps, finalScreenshot, false, `Gemini 回覆格式錯誤`)
        }
      } else {
        return buildResult(steps, finalScreenshot, false, `Gemini 回覆格式錯誤`)
      }
    }

    steps.push(step)

    if (step.done) {
      return buildResult(steps, finalScreenshot, true, step.thought)
    }

    // 3. Execute action
    await updateStatus(
      telegram, chatId, statusMessageId,
      `🖥️ 步驟 ${i + 1}/${MAX_STEPS}: ${actionLabel(step.action)}`,
    )

    try {
      await executeScreenAction(step.action, capture)
      consecutiveFailures = 0
    } catch (err) {
      consecutiveFailures++
      const msg = err instanceof Error ? err.message : String(err)
      // Append failure info so Gemini can see it next round
      steps[steps.length - 1] = {
        ...step,
        thought: step.thought + ` [FAILED: ${msg}]`,
      }
      if (consecutiveFailures >= 3) {
        return buildResult(steps, finalScreenshot, false, `連續 ${consecutiveFailures} 次操作失敗`)
      }
    }

    // 4. Wait for screen to settle
    await new Promise((r) => setTimeout(r, SETTLE_DELAY_MS))
  }

  return buildResult(steps, finalScreenshot, false, `達到最大步驟 (${MAX_STEPS})`)
}

// --- Helpers ---

async function executeScreenAction(action: AgentAction, capture: ScreenCapture): Promise<void> {
  switch (action.type) {
    case 'click_xy':
      if (action.x != null && action.y != null) {
        await clickScreen(capture, action.x, action.y)
      }
      break
    case 'fill':
      if (action.text) await typeScreen(action.text)
      break
    case 'press':
      if (action.text) await pressScreen(action.text)
      break
    case 'scroll':
      await scrollScreen(action.text === 'up' ? 'up' : 'down')
      break
    case 'done':
      break
    default:
      throw new Error(`Screen mode 不支援: ${action.type}`)
  }
}

function actionLabel(action: AgentAction): string {
  switch (action.type) {
    case 'click_xy': return `點擊 (${action.x}, ${action.y})`
    case 'fill': return `輸入 "${(action.text ?? '').slice(0, 20)}"`
    case 'press': return `按鍵 ${action.text}`
    case 'scroll': return `捲動${action.text === 'up' ? '上' : '下'}`
    case 'done': return '完成'
    default: return action.type
  }
}

function buildResult(
  steps: readonly AgentStep[],
  finalScreenshot: string | undefined,
  success: boolean,
  summary: string,
): ScreenAgentResult {
  return { steps, finalScreenshot, success, summary }
}

async function updateStatus(
  telegram: Telegram,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await telegram.editMessageText(chatId, messageId, undefined, text)
  } catch { /* ignore edit failures (race, same content) */ }
}
