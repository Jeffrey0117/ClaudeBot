/**
 * Shared limits for the remote tools.
 *
 * These used to live in index.ts, which also imports every tool module — and
 * those modules imported the constants back from './index.js'. In ESM that
 * cycle is fatal, not merely untidy: importing index.js evaluates its
 * dependencies first, so file-tools' top-level
 * `const SYSTEM_PATHS = IS_WIN ? ... : ...` read a binding still in its
 * temporal dead zone and threw
 * "ReferenceError: Cannot access 'IS_WIN' before initialization".
 *
 * The whole directory was therefore unimportable, which took the remote agent
 * down with it — src/remote/agent.ts imports the dispatcher statically, so
 * pairing and every remote tool failed before the agent could connect.
 * Verified against the built output: importing dist/remote/tool-handlers/index.js
 * threw.
 *
 * A leaf module with no local imports cannot participate in that cycle.
 */

export const MAX_FILE_SIZE = 500 * 1024
export const MAX_TRANSFER_SIZE = 20 * 1024 * 1024 // 20 MB for file transfer
export const EXEC_TIMEOUT_MS = 120_000
export const MAX_OUTPUT_SIZE = 1024 * 1024 // 1 MB output cap
export const MAX_SEARCH_RESULTS = 50
export const IS_WIN = process.platform === 'win32'
