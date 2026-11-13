import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import { z } from 'zod'

/**
 * One speech recogniser for all bot instances.
 *
 * Every bot process used to spawn its own Sherpa server, so N bots held N
 * copies of the model in memory. Now only the main bot owns the recogniser and
 * serves it on loopback; the other bots ask it to transcribe a WAV file (all
 * bots run on the same machine, so a file path is enough — no audio is sent).
 *
 * This module is transport only: the caller injects the actual transcriber, so
 * nothing here depends on Python or the model.
 */

export interface AsrResult {
  readonly success: boolean
  readonly text: string
  readonly duration: number
  readonly error?: string
}

const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 4096

const requestSchema = z.object({ wavPath: z.string().min(1).max(1024) })

/** True for `.env.botN` instances — the ones that borrow the main bot's recogniser. */
export function isSecondaryBot(argv: readonly string[] = process.argv): boolean {
  const envArg = argv.find((_, i, arr) => arr[i - 1] === '--env')
  return !!envArg && envArg !== '.env'
}

function failure(error: string): AsrResult {
  return { success: false, text: '', duration: 0, error }
}

function validateWavPath(wavPath: string): string | null {
  if (!isAbsolute(wavPath)) return 'wavPath must be absolute'
  if (extname(wavPath).toLowerCase() !== '.wav') return 'wavPath must be a .wav file'
  if (!existsSync(wavPath)) return 'wav file not found'
  return null
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: AsrResult | { ok: boolean }): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function handleTranscribe(
  req: IncomingMessage,
  res: ServerResponse,
  transcribe: (wavPath: string) => Promise<AsrResult>,
): Promise<void> {
  let parsed: z.infer<typeof requestSchema>
  try {
    parsed = requestSchema.parse(JSON.parse(await readBody(req)))
  } catch {
    send(res, 400, failure('invalid request'))
    return
  }

  const problem = validateWavPath(parsed.wavPath)
  if (problem) {
    send(res, 400, failure(problem))
    return
  }

  try {
    send(res, 200, await transcribe(parsed.wavPath))
  } catch (error) {
    send(res, 500, failure(error instanceof Error ? error.message : String(error)))
  }
}

/** Serve the given transcriber to the other bot processes. Loopback only. */
export function startSharedAsrServer(
  port: number,
  transcribe: (wavPath: string) => Promise<AsrResult>,
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      send(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && req.url === '/transcribe') {
      handleTranscribe(req, res, transcribe).catch(() => {
        if (!res.headersSent) send(res, 500, failure('internal error'))
      })
      return
    }
    send(res, 404, failure('not found'))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, () => {
      server.off('error', reject)
      server.on('error', (err) => console.error('[asr-share] server error:', err.message))
      resolve(server)
    })
  })
}

function isUnreachable(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } } | null)?.cause?.code
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'EADDRNOTAVAIL'
}

/**
 * Ask the main bot to transcribe a WAV file.
 *
 * Returns `null` only when the main bot cannot be reached at all — the one
 * case where falling back to a local recogniser makes sense. Anything else
 * (bad input, recogniser error, timeout) comes back as a failed result.
 */
export async function requestSharedAsr(port: number, wavPath: string, timeoutMs: number): Promise<AsrResult | null> {
  try {
    const res = await fetch(`http://${HOST}:${port}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wavPath }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = (await res.json()) as Partial<AsrResult>
    return {
      success: data.success === true,
      text: typeof data.text === 'string' ? data.text : '',
      duration: typeof data.duration === 'number' ? data.duration : 0,
      ...(typeof data.error === 'string' ? { error: data.error } : {}),
    }
  } catch (error) {
    if (isUnreachable(error)) return null
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return failure(timedOut ? 'Sherpa: request timed out' : error instanceof Error ? error.message : String(error))
  }
}
