export interface UserscriptMeta {
  readonly name?: string
  readonly match: readonly string[]
  readonly grants: readonly string[]
}

/** Parse the // ==UserScript== ... // ==/UserScript== metadata block. */
export function parseUserscriptMeta(code: string): UserscriptMeta {
  const block = code.match(/==UserScript==([\s\S]*?)==\/UserScript==/)
  if (!block) return { name: undefined, match: [], grants: [] }
  let name: string | undefined
  const match: string[] = []
  const grants: string[] = []
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*\/\/\s*@(\S+)\s+(.+?)\s*$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'name' && name === undefined) name = val
    else if (key === 'match' || key === 'include') match.push(val)
    else if (key === 'grant') grants.push(val)
  }
  return { name, match, grants }
}

function patternToRegex(pattern: string): RegExp {
  if (pattern === '<all_urls>' || pattern === '*') return /^https?:\/\//i
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/** Does `url` match any Tampermonkey @match/@include glob in `patterns`? */
export function matchesUrl(url: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => patternToRegex(p).test(url))
}
