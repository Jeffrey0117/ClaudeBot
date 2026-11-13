import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Size-capped log file. When the file reaches `maxBytes` it is moved aside to
 * `<file>.1` (older ones shift to `.2`, `.3`, …) and a fresh file is started;
 * only the newest `keep` old files are kept.
 *
 * Logging must never take the process down, so every failure is swallowed:
 * a rotation that fails (file held open by a reader) is simply retried on a
 * later write, and an unwritable file just drops the line.
 */

export interface RotatingLogOptions {
  readonly file: string
  readonly maxBytes: number
  readonly keep: number
}

export interface RotatingLog {
  readonly write: (text: string) => void
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function rotate({ file, keep }: RotatingLogOptions): boolean {
  try {
    rmSync(`${file}.${keep}`, { force: true })
    for (let i = keep - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`)
    }
    if (keep >= 1) {
      renameSync(file, `${file}.1`)
    } else {
      rmSync(file, { force: true })
    }
    return true
  } catch {
    return false
  }
}

export function createRotatingLog(options: RotatingLogOptions): RotatingLog {
  const { file, maxBytes } = options
  let size = sizeOf(file)

  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {
    // unwritable location — writes below will be dropped
  }

  const write = (text: string): void => {
    if (!text) return
    if (size >= maxBytes && rotate(options)) size = 0
    try {
      appendFileSync(file, text, 'utf-8')
      size += Buffer.byteLength(text, 'utf-8')
    } catch {
      // never let logging break the caller
    }
  }

  return { write }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * Returns a function that prefixes each line with the local date and time
 * (`MM-DD HH:MM:SS `). It tracks whether the previous chunk ended mid-line, so
 * a line split across writes is stamped once. Empty lines stay empty.
 */
export function createLineStamper(now: () => Date = () => new Date()): (text: string) => string {
  let atLineStart = true

  return (text: string): string => {
    if (!text) return text
    const d = now()
    const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} `

    const parts = text.split('\n')
    const out = parts.map((part, i) => {
      const startsLine = i === 0 ? atLineStart : true
      return startsLine && part.length > 0 ? stamp + part : part
    })
    atLineStart = text.endsWith('\n')
    return out.join('\n')
  }
}

type StreamWrite = typeof process.stdout.write

/**
 * Mirror everything written to stdout/stderr into `log`.
 *
 * With `passthrough: false` the original streams are no longer written to —
 * used when stdout is not a terminal (started hidden at boot), where the only
 * reader would be a redirect file that nothing rotates.
 */
export function teeProcessOutput(log: RotatingLog, opts: { readonly passthrough: boolean }): void {
  // Timestamps go into the file only — the terminal view stays as it was.
  // One stamper for both streams: they interleave into a single file.
  const stamp = createLineStamper()

  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as StreamWrite
    const patched = (chunk: unknown, ...rest: unknown[]): boolean => {
      log.write(stamp(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8')))
      if (opts.passthrough) return (original as (...a: unknown[]) => boolean)(chunk, ...rest)
      const callback = rest.find((r): r is () => void => typeof r === 'function')
      if (callback) callback()
      return true
    }
    stream.write = patched as StreamWrite
  }
}
