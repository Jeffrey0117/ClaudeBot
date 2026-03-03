import { z } from 'zod'
import dotenv from 'dotenv'
import { resolve } from 'node:path'

const envFileArg = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
const envPath = envFileArg ? resolve(envFileArg) : undefined

// override: true — launcher's dotenv.config() sets BOT_TOKEN from .env in
// process.env, and child processes inherit it.  Without override, dotenv
// skips vars that already exist, so bot2/3/4 all end up with the main
// bot's token → 409 conflict on Telegram polling.
dotenv.config({ ...(envPath ? { path: envPath } : {}), override: true })

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  LOGIN_PASSWORD: z.string().default(''),
  LOGIN_PASSWORD_HASH: z.string().default(''),
  ALLOWED_CHAT_IDS: z
    .string()
    .min(1, 'ALLOWED_CHAT_IDS is required')
    .transform((val) => val.split(',').map((id) => parseInt(id.trim(), 10)))
    .pipe(z.array(z.number().int().positive())),
  PROJECTS_BASE_DIR: z
    .string()
    .min(1, 'PROJECTS_BASE_DIR is required')
    .transform((val) => val.split(',').map((d) => d.trim()).filter(Boolean)),
  DEFAULT_MODEL: z.enum(['haiku', 'sonnet', 'opus']).default('sonnet'),
  GEMINI_API_KEY: z.string().default(''),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  MAX_TURNS: z.coerce.number().int().positive().optional(),
  PLUGINS: z
    .string()
    .default('')
    .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean)),
  SKIP_PERMISSIONS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((val) => val === 'true'),
  AUTO_AUTH: z
    .enum(['true', 'false'])
    .default('true')
    .transform((val) => val === 'true'),
  DASHBOARD: z
    .enum(['true', 'false'])
    .default('false')
    .transform((val) => val === 'true'),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3100),
  ANTHROPIC_ADMIN_KEY: z.string().default(''),
  GITHUB_TOKEN: z.string().default(''),
  SHERPA_SERVER_PATH: z.string().default(''),
  MCP_BROWSER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((val) => val === 'true'),
  MCP_AGENT_BROWSER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((val) => val === 'true'),
  PLUGIN_REGISTRY_URL: z
    .string()
    .default('https://raw.githubusercontent.com/Jeffrey0117/claudebot-plugins/master/registry.json'),
  PREVENT_SLEEP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((val) => val === 'true'),
  ADMIN_CHAT_ID: z.coerce.number().int().positive().optional(),
  AUTO_COMMIT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((val) => val === 'true'),
  BIAODIAN_PATH: z.string().default(''),
  RELAY_PORT: z.coerce.number().int().positive().default(9877),
  REMOTE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((val) => val === 'true'),
  TELEGRAM_PROXY: z.string().default(''),
  TELEGRAM_API_BASE: z.string().default(''),
  WORKTREE_BRANCH: z.string().default(''),
  WORKTREE_PROJECTS: z
    .string()
    .default('')
    .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean)),
  MAX_PARALLEL: z.coerce.number().int().min(2).max(10).default(3),
})

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const formatted = result.error.format()
    const messages = Object.entries(formatted)
      .filter(([key]) => key !== '_errors')
      .map(([key, val]) => {
        const errors = (val as { _errors: string[] })._errors
        return `  ${key}: ${errors.join(', ')}`
      })
      .join('\n')
    throw new Error(`Environment validation failed:\n${messages}`)
  }
  const data = result.data
  if (!data.AUTO_AUTH && !data.LOGIN_PASSWORD && !data.LOGIN_PASSWORD_HASH) {
    throw new Error('Either LOGIN_PASSWORD or LOGIN_PASSWORD_HASH must be set (or enable AUTO_AUTH)')
  }
  return data
}

export const env = loadEnv()
