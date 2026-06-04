import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { env } from '../config/env.js'

/** Pushes a message to a Telegram chat. Injected by index.ts so this module
 *  stays decoupled from the bot instance. */
export type PushToChat = (
  chatId: number,
  text: string,
  opts?: { silent?: boolean }
) => Promise<void>

const EventSchema = z.object({
  /** Logical channel name → resolved to a chatId via CLOUDPIPE_ROUTES. */
  channel: z.string().min(1).max(64).optional(),
  /** Message body. Telegram caps at ~4096 chars. */
  text: z.string().min(1, 'text is required').max(4000),
  /** Optional short label shown as a bold header (e.g. "Deploy failed"). */
  event: z.string().max(100).optional(),
  /** When true, sends silently (no notification sound). */
  silent: z.boolean().default(false),
})

export type CloudPipeEvent = z.infer<typeof EventSchema>

/** Resolve a channel to a target chatId, falling back to ADMIN_CHAT_ID. */
export function resolveChatId(channel: string | undefined): number | null {
  if (channel && env.CLOUDPIPE_ROUTES[channel] !== undefined) {
    return env.CLOUDPIPE_ROUTES[channel]
  }
  return env.ADMIN_CHAT_ID ?? null
}

/** Build the Telegram message text from a validated event. */
export function formatEvent(event: CloudPipeEvent): string {
  return event.event ? `🔔 *${event.event}*\n${event.text}` : event.text
}

type Deps = {
  readonly pushToChat: PushToChat | null
  readonly readBody: (req: IncomingMessage) => Promise<string>
  readonly sendJson: (res: ServerResponse, data: unknown, status?: number) => void
}

/**
 * Handle POST /api/cloudpipe/event.
 * Auth via X-CloudPipe-Token header (constant-secret compare).
 * Routes channel→chatId and forwards to Telegram via the injected callback.
 */
export async function handleCloudPipeEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps
): Promise<void> {
  const { pushToChat, readBody, sendJson } = deps

  // Endpoint disabled when no token is configured (fail closed).
  if (!env.CLOUDPIPE_TOKEN) {
    sendJson(res, { error: 'CloudPipe webhook not configured' }, 503)
    return
  }

  // Auth check
  const token = req.headers['x-cloudpipe-token']
  if (typeof token !== 'string' || token !== env.CLOUDPIPE_TOKEN) {
    sendJson(res, { error: 'Unauthorized' }, 401)
    return
  }

  if (!pushToChat) {
    sendJson(res, { error: 'Bot not ready' }, 503)
    return
  }

  let event: CloudPipeEvent
  try {
    const raw = JSON.parse(await readBody(req))
    event = EventSchema.parse(raw)
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : 'Invalid request body'
    sendJson(res, { error: message }, 400)
    return
  }

  const chatId = resolveChatId(event.channel)
  if (chatId === null) {
    sendJson(
      res,
      { error: `No route for channel "${event.channel ?? '(none)'}" and ADMIN_CHAT_ID unset` },
      422
    )
    return
  }

  try {
    await pushToChat(chatId, formatEvent(event), { silent: event.silent })
    sendJson(res, { ok: true, chatId }, 200)
  } catch (err) {
    console.error('[cloudpipe] Failed to deliver event:', err)
    sendJson(res, { error: 'Delivery failed' }, 502)
  }
}
