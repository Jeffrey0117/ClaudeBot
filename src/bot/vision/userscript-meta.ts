export interface UserscriptMeta {
  readonly name?: string
  readonly match: readonly string[]
  readonly grants: readonly string[]
  readonly requires: readonly string[]
  readonly resources: ReadonlyArray<{ readonly name: string; readonly url: string }>
}

/** Parse the // ==UserScript== ... // ==/UserScript== metadata block. */
export function parseUserscriptMeta(code: string): UserscriptMeta {
  const block = code.match(/==UserScript==([\s\S]*?)==\/UserScript==/)
  if (!block) return { name: undefined, match: [], grants: [], requires: [], resources: [] }
  let name: string | undefined
  const match: string[] = []
  const grants: string[] = []
  const requires: string[] = []
  const resources: Array<{ name: string; url: string }> = []
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*\/\/\s*@(\S+)\s+(.+?)\s*$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'name' && name === undefined) name = val
    else if (key === 'match' || key === 'include') match.push(val)
    else if (key === 'grant') grants.push(val)
    else if (key === 'require') requires.push(val)
    else if (key === 'resource') {
      const sp = val.split(/\s+/)
      if (sp.length >= 2) resources.push({ name: sp[0], url: sp.slice(1).join(' ') })
    }
  }
  return { name, match, grants, requires, resources }
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
