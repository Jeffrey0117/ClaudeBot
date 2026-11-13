/**
 * Compare two semver-ish strings. Returns true when `candidate` is newer.
 * Prerelease suffixes are stripped, so 1.2.3-beta compares equal to 1.2.3 —
 * deterministic, and errs towards NOT prompting rather than prompting wrongly.
 *
 * Kept free of electron imports so it can be tested directly.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('-')[0].split('.').map((p) => Number.parseInt(p, 10) || 0)
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}
