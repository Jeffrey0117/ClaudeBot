/**
 * Gemini Vision API for agent-mode structured output.
 * Uses responseMimeType: 'application/json' + responseSchema
 * to force structured JSON replies for the web agent loop.
 */
import { env } from '../config/env.js'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const TIMEOUT_MS = 30_000

// --- Types ---

export interface AgentAction {
  readonly type: 'click' | 'fill' | 'press' | 'scroll' | 'navigate' | 'done'
  readonly selector?: string
  readonly text?: string
}

export interface AgentStep {
  readonly thought: string
  readonly action: AgentAction
  readonly done: boolean
}

export interface GeminiAgentResult {
  readonly step: AgentStep | null
  readonly error?: string
}

export interface ScreenshotDiff {
  readonly hasDiff: boolean
  readonly summary: string
}

// --- JSON Schema for Gemini structured output ---

const AGENT_RESPONSE_SCHEMA = {
  type: 'OBJECT' as const,
  properties: {
    thought: { type: 'STRING' as const, description: 'Your reasoning about what you see and what to do next' },
    action: {
      type: 'OBJECT' as const,
      properties: {
        type: { type: 'STRING' as const, enum: ['click', 'fill', 'press', 'scroll', 'navigate', 'done'] },
        selector: { type: 'STRING' as const, description: 'Element selector: role=button[name="X"], text="Y", or CSS selector' },
        text: { type: 'STRING' as const, description: 'Text to fill or key to press or URL to navigate to' },
      },
      required: ['type'],
    },
    done: { type: 'BOOLEAN' as const, description: 'true if the task is complete' },
  },
  required: ['thought', 'action', 'done'],
}

const DIFF_RESPONSE_SCHEMA = {
  type: 'OBJECT' as const,
  properties: {
    hasDiff: { type: 'BOOLEAN' as const, description: 'Whether visual differences were detected' },
    summary: { type: 'STRING' as const, description: 'Description of the differences found (or "No differences" if identical)' },
  },
  required: ['hasDiff', 'summary'],
}

// --- Build prompt ---

function buildAgentPrompt(
  instruction: string,
  accessTree: string,
  history: readonly AgentStep[],
): string {
  const historyText = history.length > 0
    ? '\n\nPrevious steps:\n' + history.map((s, i) =>
      `Step ${i + 1}: ${s.thought} → ${s.action.type}${s.action.selector ? ` on "${s.action.selector}"` : ''}${s.action.text ? ` with "${s.action.text}"` : ''}`,
    ).join('\n')
    : ''

  return (
    'You are a web automation agent. You receive a screenshot of a webpage and its accessibility tree.\n' +
    'Your task: ' + instruction + '\n\n' +
    'Accessibility tree:\n' + accessTree + '\n' +
    historyText + '\n\n' +
    'Instructions:\n' +
    '- Analyze the screenshot and accessibility tree to decide the next action\n' +
    '- Use selectors the browser can find: role=button[name="X"], text="Y", or CSS selectors like #id, .class\n' +
    '- For fill actions, provide both selector and text\n' +
    '- For press actions, provide key name in text (e.g. "Enter", "Tab", "Escape")\n' +
    '- For scroll actions, provide direction in text ("up" or "down")\n' +
    '- For navigate actions, provide full URL in text\n' +
    '- Set done=true when the task is complete or you cannot proceed\n' +
    '- If an element was not found in a previous step, try a different selector\n' +
    '- Do NOT fill password fields unless the instruction explicitly asks for it\n' +
    '- IMPORTANT: If you see a CAPTCHA, reCAPTCHA, or "I\'m not a robot" challenge, set done=true immediately and explain in thought that a CAPTCHA is blocking progress\n' +
    '- IMPORTANT: Selectors MUST use the role= prefix for ARIA roles, e.g. role=combobox[name="Search"], role=button[name="Submit"]\n' +
    '- IMPORTANT: For text selectors, use ONLY the clickable element\'s own text, NOT surrounding text. Example: if you see "沒有帳號？註冊" where "註冊" is a link, use text="註冊" or role=link[name="註冊"], NOT text="沒有帳號？註冊"\n' +
    '- IMPORTANT: If "元素不存在" error occurs, the element text you used is wrong. Look at the accessibility tree carefully and use the EXACT text from there. Try shorter, more specific selectors.'
  )
}

// --- API calls ---

export async function analyzeForAction(
  screenshotBase64: string,
  accessTree: string,
  instruction: string,
  history: readonly AgentStep[],
): Promise<GeminiAgentResult> {
  if (!env.GEMINI_API_KEY) {
    return { step: null, error: 'GEMINI_API_KEY 未設定' }
  }

  const prompt = buildAgentPrompt(instruction, accessTree, history)

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/png', data: screenshotBase64 } },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: AGENT_RESPONSE_SCHEMA,
      maxOutputTokens: 1024,
    },
  }

  const result = await callGeminiApi(body)
  if (result.error) return { step: null, error: result.error }

  try {
    const parsed = JSON.parse(result.text) as AgentStep
    return { step: parsed }
  } catch {
    return { step: null, error: `Invalid JSON from Gemini: ${result.text.slice(0, 200)}` }
  }
}

export async function compareScreenshots(
  beforeBase64: string,
  afterBase64: string,
  pageUrl: string,
): Promise<ScreenshotDiff> {
  if (!env.GEMINI_API_KEY) {
    return { hasDiff: false, summary: 'GEMINI_API_KEY 未設定' }
  }

  const prompt = (
    '請用繁體中文回覆。\n' +
    '比較這兩張網頁截圖（部署前 vs 部署後），來自: ' + pageUrl + '\n\n' +
    '第一張是「部署前」，第二張是「部署後」。\n' +
    '找出所有視覺差異：佈局變化、文字變更、顏色改變、元素消失或新增等。\n' +
    '如果沒有差異，設定 hasDiff=false。'
  )

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/png', data: beforeBase64 } },
        { inline_data: { mime_type: 'image/png', data: afterBase64 } },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: DIFF_RESPONSE_SCHEMA,
      maxOutputTokens: 2048,
    },
  }

  const result = await callGeminiApi(body)
  if (result.error) return { hasDiff: false, summary: `比對失敗: ${result.error}` }

  try {
    return JSON.parse(result.text) as ScreenshotDiff
  } catch {
    return { hasDiff: false, summary: `Invalid JSON: ${result.text.slice(0, 200)}` }
  }
}

// --- Shared fetch helper ---

async function callGeminiApi(
  body: Record<string, unknown>,
  model = 'gemini-2.5-flash',
): Promise<{ text: string; error?: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(
      `${API_BASE}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    )
    clearTimeout(timeout)

    if (!res.ok) {
      const errText = await res.text()
      return { text: '', error: `Gemini API ${res.status}: ${errText.slice(0, 300)}` }
    }

    const data = (await res.json()) as {
      candidates?: ReadonlyArray<{
        content?: { parts?: ReadonlyArray<{ text?: string }> }
        finishReason?: string
      }>
      error?: { message?: string }
    }

    if (data.error) {
      return { text: '', error: data.error.message ?? 'Unknown Gemini API error' }
    }

    const text = data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('') ?? ''

    if (!text) {
      const reason = data.candidates?.[0]?.finishReason
      return { text: '', error: `Gemini 無回覆 (finishReason: ${reason ?? 'unknown'})` }
    }

    return { text }
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      return { text: '', error: '分析逾時 (30s)' }
    }
    return { text: '', error: err instanceof Error ? err.message : String(err) }
  }
}
