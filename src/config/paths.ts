import { join } from 'node:path'

/**
 * Root for the bot's MUTABLE state (.sessions.json, data/*.json, …).
 *
 * Every store resolved its path against process.cwd() directly, so running the
 * test suite wrote fixtures straight into the live files: .sessions.json,
 * data/todos.json, data/context-pins.json and data/last-responses.json had
 * accumulated 66 junk entries between them — at one point burying the owner's
 * single real context pin among ten fake ones.
 *
 * CLAUDEBOT_STATE_DIR exists purely as a test seam. It is read on every call
 * rather than captured once, so a test setup file can point it at a temp
 * directory before any store module is imported.
 *
 * Read-only configuration (data/system-prompt.md, data/ctx-spec.md) is
 * deliberately NOT routed through here — those are repo content the suite is
 * entitled to read, not state it should be writing.
 */
export function stateRoot(): string {
  return process.env.CLAUDEBOT_STATE_DIR ?? process.cwd()
}

/** Path inside the state root, e.g. statePath('data', 'todos.json'). */
export function statePath(...segments: readonly string[]): string {
  return join(stateRoot(), ...segments)
}
