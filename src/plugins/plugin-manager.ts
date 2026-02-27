import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../config/env.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// --- Types ---

export interface RegistryEntry {
  readonly name: string
  readonly description: string
  readonly commands: readonly { readonly name: string; readonly description: string }[]
  readonly author: string
  readonly version?: string
}

// --- Persistence: data/enabled-plugins.json ---

const DATA_PATH = resolve('data/enabled-plugins.json')

function ensureDir(): void {
  const dir = dirname(DATA_PATH)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function loadEnabledList(): readonly string[] {
  try {
    const raw = readFileSync(DATA_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string')
  } catch {
    // file doesn't exist yet — fallback below
  }
  return []
}

function saveEnabledList(list: readonly string[]): void {
  ensureDir()
  writeFileSync(DATA_PATH, JSON.stringify(list, null, 2), 'utf-8')
}

/**
 * Get the list of enabled plugins.
 * If data/enabled-plugins.json exists, use it. Otherwise fallback to env.PLUGINS.
 */
export function getEnabledPlugins(): readonly string[] {
  if (existsSync(DATA_PATH)) {
    return loadEnabledList()
  }
  return env.PLUGINS
}

export function enablePlugin(name: string): readonly string[] {
  const current = [...getEnabledPlugins()]
  if (!current.includes(name)) {
    const updated = [...current, name]
    saveEnabledList(updated)
    return updated
  }
  saveEnabledList(current)
  return current
}

export function disablePlugin(name: string): readonly string[] {
  const current = [...getEnabledPlugins()]
  const updated = current.filter((n) => n !== name)
  saveEnabledList(updated)
  return updated
}

// --- Local install check ---

export function isInstalled(name: string): boolean {
  const pluginDir = join(__dirname, name)
  const indexPath = join(pluginDir, 'index.ts')
  const indexJsPath = join(pluginDir, 'index.js')
  return existsSync(indexPath) || existsSync(indexJsPath)
}

// --- Registry fetch ---

export async function fetchRegistry(): Promise<readonly RegistryEntry[]> {
  const url = env.PLUGIN_REGISTRY_URL
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ClaudeBot-PluginStore' },
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    throw new Error(`Registry fetch failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as { plugins?: RegistryEntry[] }
  return data.plugins ?? []
}

// --- Download plugin from GitHub ---

interface GitHubContent {
  readonly name: string
  readonly type: 'file' | 'dir'
  readonly download_url: string | null
  readonly path: string
}

async function ghFetch(path: string): Promise<Response> {
  const token = env.GITHUB_TOKEN
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ClaudeBot-PluginStore',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  })
}

/**
 * Download a plugin from the registry repo.
 * Fetches all files under plugins/{name}/ and writes them to src/plugins/{name}/
 */
export async function downloadPlugin(name: string): Promise<void> {
  const repoPath = `/repos/Jeffrey0117/claudebot-plugins/contents/plugins/${encodeURIComponent(name)}`
  const res = await ghFetch(repoPath)

  if (!res.ok) {
    throw new Error(`Plugin "${name}" not found in registry (${res.status})`)
  }

  const contents = await res.json() as GitHubContent[]
  if (!Array.isArray(contents)) {
    throw new Error(`Unexpected response format for plugin "${name}"`)
  }

  const targetDir = join(__dirname, name)
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  for (const item of contents) {
    if (item.type === 'file' && item.download_url) {
      const fileRes = await fetch(item.download_url, {
        headers: { 'User-Agent': 'ClaudeBot-PluginStore' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!fileRes.ok) {
        throw new Error(`Failed to download ${item.name}: ${fileRes.status}`)
      }
      const content = await fileRes.text()
      writeFileSync(join(targetDir, item.name), content, 'utf-8')
    }
  }
}

// --- Remove plugin ---

export function removePlugin(name: string): void {
  const pluginDir = join(__dirname, name)
  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true })
  }
}
