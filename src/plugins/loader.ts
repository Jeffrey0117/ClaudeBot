import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import type { Plugin } from '../types/plugin.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let loadedPlugins: readonly Plugin[] = []

export async function loadPlugins(pluginNames: readonly string[]): Promise<readonly Plugin[]> {
  if (pluginNames.length === 0) {
    loadedPlugins = []
    return loadedPlugins
  }

  const pluginsDir = __dirname
  const results: Plugin[] = []

  for (const name of pluginNames) {
    const pluginDir = join(pluginsDir, name)

    if (!existsSync(pluginDir)) {
      console.warn(`[plugins] Plugin "${name}" not found at ${pluginDir}, skipping`)
      continue
    }

    try {
      const mod = await import(`./${name}/index.js`)
      const plugin: Plugin = mod.default

      if (!plugin || !plugin.name || !Array.isArray(plugin.commands)) {
        console.warn(`[plugins] Plugin "${name}" has invalid export, skipping`)
        continue
      }

      results.push(plugin)
      console.log(`[plugins] Loaded: ${plugin.name} (${plugin.commands.length} commands)`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[plugins] Failed to load "${name}": ${msg}`)
    }
  }

  loadedPlugins = results
  return loadedPlugins
}

export function getLoadedPlugins(): readonly Plugin[] {
  return loadedPlugins
}
