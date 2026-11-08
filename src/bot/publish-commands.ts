import type { Telegram } from 'telegraf'

export interface BotCommandSpec {
  readonly command: string
  readonly description: string
}

/** Telegram accepts only lowercase latin letters, digits and underscores, 1-32 chars. */
const VALID_COMMAND_NAME = /^[a-z0-9_]{1,32}$/

export function isValidCommandName(name: string): boolean {
  return VALID_COMMAND_NAME.test(name)
}

/**
 * Push the command list to Telegram's autocomplete menu.
 *
 * Telegram validates the WHOLE payload: a single malformed name makes it
 * reject every command with a 400, leaving the menu on whatever snapshot it
 * last accepted. That is exactly what happened — the `write` plugin exported
 * `write-note`, the hyphen is illegal, and all four call sites swallowed the
 * error with `.catch(() => {})`, so the menu silently froze months out of date
 * and `/vault` / `/save` looked broken when they were merely unlisted.
 *
 * Two rules here: drop invalid names so one bad plugin cannot blank the menu,
 * and never swallow the failure.
 */
export async function publishBotCommands(
  telegram: Telegram,
  commands: readonly BotCommandSpec[],
): Promise<void> {
  const valid: BotCommandSpec[] = []
  const invalid: string[] = []

  for (const c of commands) {
    if (isValidCommandName(c.command)) valid.push(c)
    else invalid.push(c.command)
  }

  if (invalid.length > 0) {
    console.error(
      `[bot] ${invalid.length} command name(s) rejected by Telegram's naming rules, ` +
        `excluded so the rest still register: ${invalid.join(', ')}`,
    )
  }

  try {
    await telegram.setMyCommands(valid.map((c) => ({ ...c })))
  } catch (err) {
    console.error(
      '[bot] setMyCommands failed — the autocomplete menu is now stale:',
      err instanceof Error ? err.message : err,
    )
  }
}
