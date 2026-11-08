/**
 * Public HTTP route for generated pages: GET /p/<32 hex>.
 *
 * Pages share an origin with the relay, so they are served under a CSP sandbox:
 * the browser gives them an opaque origin and their scripts cannot make
 * same-origin calls back to the relay. Scripts and CDN chart libraries still run.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  defaultPagesDir,
  getIndexToken,
  listPages,
  readPage,
  renderOverview,
} from './page-store.js'

const ROUTE_RE = /^\/p\/([a-f0-9]{32})\/?$/

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
} as const

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' })
  res.end(text)
}

async function resolveHtml(dir: string, id: string): Promise<string | null> {
  if (id === (await getIndexToken(dir))) {
    return renderOverview(await listPages(dir))
  }
  return readPage(dir, id)
}

async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  id: string,
): Promise<void> {
  try {
    const html = await resolveHtml(dir, id)
    if (html === null) {
      sendText(res, 404, 'Not found')
      return
    }
    res.writeHead(200, PAGE_HEADERS)
    res.end(req.method === 'HEAD' ? undefined : html)
  } catch (err) {
    console.error('[pages] failed to serve page:', err instanceof Error ? err.message : err)
    sendText(res, 500, 'Error')
  }
}

/** Returns true when the request belongs to this route and has been handled. */
export function handlePageRequest(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string = defaultPagesDir(),
): boolean {
  const pathname = (req.url ?? '').split('?')[0]
  const match = ROUTE_RE.exec(pathname)
  if (!match) return false

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed')
    return true
  }
  void respond(req, res, dir, match[1])
  return true
}
