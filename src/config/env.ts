import { z } from 'zod'
import dotenv from 'dotenv'
import { resolve } from 'node:path'

const envFileArg = process.argv.find((_, i, arr) => arr[i - 1] === '--env')
const envPath = envFileArg ? resolve(envFileArg) : undefined

dotenv.config(envPath ? { path: envPath } : undefined)

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  LOGIN_PASSWORD: z.string().default(''),
  LOGIN_PASSWORD_HASH: z.string().default(''),
  ALLOWED_CHAT_IDS: z
    .string()
    .min(1, 'ALLOWED_CHAT_IDS is required')
    .transform((val) => val.split(',').map((id) => parseInt(id.trim(), 10)))
    .pipe(z.array(z.number().int().positive())),
  PROJECTS_BASE_DIR: z.string().min(1, 'PROJECTS_BASE_DIR is required'),
  DEFAULT_MODEL: z.enum(['haiku', 'sonnet', 'opus']).default('sonnet'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  MAX_TURNS: z.coerce.number().int().positive().optional(),
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
  if (!data.LOGIN_PASSWORD && !data.LOGIN_PASSWORD_HASH) {
    throw new Error('Either LOGIN_PASSWORD or LOGIN_PASSWORD_HASH must be set')
  }
  return data
}

export const env = loadEnv()
