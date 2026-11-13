/**
 * The one place that says what a bot instance is called.
 *
 * The launcher starts each instance with `--env <file>`; the id derived from
 * that file names its heartbeat (`data/heartbeat/<id>.json`), its dashboard
 * commands and its labels. The launcher and the bot must derive it the same
 * way — when they disagreed ('main' vs 'bot1') the watchdog watched a file
 * that was never written.
 *
 * Deliberately dependency-free: the launcher imports this without loading the
 * bot's configuration.
 */

const MAIN_ENV_FILE = '.env'
const MAIN_BOT_ID = 'bot1'

/** '.env' → 'bot1', '.env.bot3' → 'bot3'. */
export function botIdFromEnvFile(envFile: string | undefined): string {
  if (!envFile || envFile === MAIN_ENV_FILE) return MAIN_BOT_ID
  return envFile.replace('.env.', '')
}

/** The value passed after `--env`, if any. */
export function envFileFromArgv(argv: readonly string[] = process.argv): string | undefined {
  return argv.find((_, i, arr) => arr[i - 1] === '--env')
}

/** Id of the bot instance running in this process. */
export function deriveBotId(argv: readonly string[] = process.argv): string {
  return botIdFromEnvFile(envFileFromArgv(argv))
}

/** True for `.env.botN` instances; the main bot hosts the shared services. */
export function isSecondaryBot(argv: readonly string[] = process.argv): boolean {
  const envFile = envFileFromArgv(argv)
  return !!envFile && envFile !== MAIN_ENV_FILE
}
