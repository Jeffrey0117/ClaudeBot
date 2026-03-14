/**
 * Direct Gemini API call with vision (multimodal).
 * Bypasses Gemini CLI — the CLI has no image input support.
 */
import { readFileSync } from 'node:fs'
import { env } from '../config/env.js'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const TIMEOUT_MS = 60_000

interface GeminiVisionResult {
  readonly text: string
  readonly error?: string
}

export async function analyzeImageFromPath(
  imagePath: string,
  prompt: string,
  model = 'gemini-2.5-flash',
): Promise<GeminiVisionResult> {
  const imageData = readFileSync(imagePath).toString('base64')
  return analyzeImageFromBase64(imageData, 'image/png', prompt, model)
}

export async function analyzeImageFromBase64(
  base64Data: string,
  mimeType: string,
  prompt: string,
  model = 'gemini-2.5-flash',
): Promise<GeminiVisionResult> {
  if (!env.GEMINI_API_KEY) {
    return { text: '', error: 'GEMINI_API_KEY 未設定' }
  }

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Data } },
      ],
    }],
    generationConfig: {
      maxOutputTokens: 4096,
    },
  }

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
      return { text: '', error: '分析逾時 (60s)' }
    }
    return { text: '', error: err instanceof Error ? err.message : String(err) }
  }
}
