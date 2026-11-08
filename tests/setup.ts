import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Point the bot's mutable state at a throwaway directory for the whole suite.
 *
 * Without this, every store resolved against process.cwd() and the tests wrote
 * into the live files — .sessions.json, data/todos.json, data/context-pins.json
 * and data/last-responses.json collected 66 junk entries, at one point burying
 * the owner's only real context pin among ten fake ones.
 *
 * This runs before any test file is imported, which matters: the stores capture
 * their path at module load.
 */
const root = mkdtempSync(join(tmpdir(), 'claudebot-test-'))
mkdirSync(join(root, 'data'), { recursive: true })
process.env.CLAUDEBOT_STATE_DIR = root
