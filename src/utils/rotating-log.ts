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

type StreamWrite = typeof process.stdout.write

/**
 * Mirror everything written to stdout/stderr into `log`.
 *
 * With `passthrough: false` the original streams are no longer written to —
 * used when stdout is not a terminal (started hidden at boot), where the only
 * reader would be a redirect file that nothing rotates.
 */
export function teeProcessOutput(log: RotatingLog, opts: { readonly passthrough: boolean }): void {
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as StreamWrite
    const patched = (chunk: unknown, ...rest: unknown[]): boolean => {
      log.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'))
      if (opts.passthrough) return (original as (...a: unknown[]) => boolean)(chunk, ...rest)
      const callback = rest.find((r): r is () => void => typeof r === 'function')
      if (callback) callback()
      return true
    }
    stream.write = patched as StreamWrite
  }
}
