import { writeFile, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const TEMP_DIR = join(tmpdir(), 'claudebot-images')

async function ensureTempDir(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true })
}

export async function downloadImage(fileUrl: string, extension: string): Promise<string> {
  await ensureTempDir()

  const filename = `${randomUUID()}.${extension}`
  const filePath = join(TEMP_DIR, filename)

  const response = await fetch(fileUrl)
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status} ${response.statusText}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(filePath, buffer)

  return filePath
}

export async function cleanupImage(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch {
    // ignore cleanup errors
  }
}
