/**
 * remote_ig_post — run the IG CDP posting flow ON THIS MACHINE (the agent
 * side, where the CDP Chrome lives). The bot pushes the media here first
 * (remote_push_file for ≤20MB, or a pokkit URL for bigger files), then
 * calls this tool with a local path or URL.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runIgCdpPost, runIgCdpResume } from '../../bot/vision/ig-cdp-flow.js'

const URL_DOWNLOAD_TIMEOUT_MS = 180_000

export async function handleIgPost(
  args: Record<string, unknown>,
  validatePath: (p: string) => string,
): Promise<string> {
  const caption = String(args.caption ?? '').trim()
  if (!caption) throw new Error('caption is required')

  // Resume mode: pick up a stuck flow from the current IG screen (no media)
  if (args.resume === true || args.resume === 'true') {
    const resumed = await runIgCdpResume(caption)
    return JSON.stringify(resumed)
  }

  let filePath = args.path ? validatePath(String(args.path)) : ''

  // No local path → download from URL (pokkit route for >20MB files)
  if (!filePath && args.url) {
    const url = String(args.url)
    if (!/^https?:\/\//i.test(url)) throw new Error(`Invalid url: ${url}`)
    const name =
      String(args.filename ?? '').replace(/[/\\]/g, '_').replace(/\.\./g, '_').trim()
      || `ig-${Date.now()}.mp4`

    const res = await fetch(url, { signal: AbortSignal.timeout(URL_DOWNLOAD_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`Media download failed: ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())

    const dir = join(tmpdir(), 'claudebot-ig')
    await mkdir(dir, { recursive: true })
    filePath = join(dir, name)
    await writeFile(filePath, buffer)
  }

  if (!filePath) throw new Error('Either path or url is required')

  const result = await runIgCdpPost(filePath, caption)
  return JSON.stringify(result)
}
