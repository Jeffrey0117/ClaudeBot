import { spawn, execSync } from 'node:child_process'
import path from 'node:path'

function resolveClaudeCli(): { cmd: string; prefix: readonly string[] } {
  if (process.platform !== 'win32') {
    return { cmd: 'claude', prefix: [] }
  }
  try {
    const cmdPath = execSync('where claude.cmd', { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0].trim()
    const dir = path.dirname(cmdPath)
    const cliJs = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    return { cmd: process.execPath, prefix: [cliJs] }
  } catch {
    return { cmd: 'claude', prefix: [] }
  }
}

const cli = resolveClaudeCli()

const SYSTEM_PROMPT = `你是一個 Telegram bot 的建議引擎。根據 Claude 剛完成的任務回應，建議 1-3 個使用者可能想做的下一步。

規則：
- 每個建議 ≤ 40 個字元
- 建議要具體可執行（不是模糊的描述）
- 用中文
- 常見的下一步：跑測試、提交 commit、code review、修 bug、加錯誤處理、更新文件
- 如果回應是完成某功能 → 建議測試/提交/相關功能
- 如果回應是修 bug → 建議驗證/跑測試/找類似問題
- 如果回應是問答/解釋 → 可能不需要建議，回傳空陣列

回傳 JSON 陣列，不要任何其他文字：
["建議1", "建議2"]`

export async function generateSuggestions(
  responseText: string,
  projectName: string,
): Promise<readonly string[]> {
  const truncated = responseText.slice(-1500)
  const prompt = `專案: ${projectName}\n\nClaude 的回應:\n---\n${truncated}\n---\n\n建議下一步 (JSON 陣列):`

  return new Promise<readonly string[]>((resolve) => {
    let done = false
    const finish = (result: readonly string[]) => {
      if (done) return
      done = true
      resolve(result)
    }

    const args = [
      ...cli.prefix,
      '-p', prompt,
      '--output-format', 'stream-json',
      '--model', 'haiku',
      '--max-turns', '1',
      '--dangerously-skip-permissions',
      '--append-system-prompt', SYSTEM_PROMPT,
    ]

    const proc = spawn(cli.cmd, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const timeout = setTimeout(() => {
      try { proc.kill() } catch { /* ignore */ }
      finish([])
    }, 8_000)

    let buffer = ''
    let resultText = ''

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          if (event.type === 'result' && event.result) {
            resultText = event.result
          } else if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                resultText = block.text
              }
            }
          }
        } catch { /* skip */ }
      }
    })

    proc.on('close', () => {
      clearTimeout(timeout)
      try {
        // Extract JSON array from response (may have surrounding text)
        const match = resultText.match(/\[[\s\S]*?\]/)
        if (!match) { finish([]); return }

        const parsed = JSON.parse(match[0])
        if (!Array.isArray(parsed)) { finish([]); return }

        const suggestions = parsed
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
          .slice(0, 3)
          .map((s) => s.slice(0, 50))

        finish(suggestions)
      } catch {
        finish([])
      }
    })

    proc.on('error', () => {
      clearTimeout(timeout)
      finish([])
    })
  })
}
