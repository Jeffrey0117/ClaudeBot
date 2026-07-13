# BAT Remote Protocol

How to drive a **Better Agent Terminal (BAT)** host as a remote client: connect
to its WebSocket server, authenticate, start an agent session, send a prompt, and
consume the streaming reply.

This is written from BAT's Rust implementation (the authoritative source):

- Server: `src-tauri/src/remote_server.rs`
- Reference client (BAT connecting to another BAT host): `src-tauri/src/remote_client.rs`
- Frame/channel codec: `src-tauri/src/remote_core.rs`
- Renderer call surface: `renderer/src/host-api.ts`

> **State ownership.** BAT remote state is **host-owned**. A client sends
> *mutation requests*; the host applies (or rejects) them, returns the result,
> and **broadcasts** canonical state changes as events. Do **not** optimistically
> render final state on the client — render what the host sends back.

---

## 1. Transport & connection URL

- **URL:** `wss://<host>:<port>/` — always **TLS**, always the root path.
- **Default port:** `9876` (`DEFAULT_REMOTE_PORT`). The host may bind a different
  one; the effective port is shown in the host's Settings → Remote panel.
- The host uses a **self-signed certificate**. Standard CA validation will fail.
  The client must instead **pin the certificate fingerprint** (see below).

### TLS certificate pinning (mandatory)

The server presents a self-signed cert; the reference client disables CA
verification and pins the **SHA-256 fingerprint** of the leaf certificate
(`remote_client.rs::connect_socket` → `fingerprint mismatch` error on mismatch).

- Fingerprint format: **uppercase hex, colon-separated** SHA-256 of the cert DER,
  e.g. `AB:CD:EF:...` (32 bytes → 47 chars). This equals Node's
  `TLSSocket.getPeerCertificate().fingerprint256`.
- Comparison is normalized: strip non-hex, uppercase, regroup in pairs. So
  `ab cd-ef` and `AB:CD:EF` are equal.
- You obtain the expected fingerprint **out of band** from the host (Settings →
  Remote, or the pairing QR payload).

In Node with `ws`:

```js
const ws = new WebSocket(url, { rejectUnauthorized: false, perMessageDeflate: false })
ws.on('upgrade', (res) => {
  const actual = res.socket.getPeerCertificate().fingerprint256 // "AB:CD:.."
  if (normalize(actual) !== normalize(expectedFingerprint)) ws.terminate()
})
```

`rejectUnauthorized:false` lets the self-signed cert through; the fingerprint
check is what actually secures the channel. Reject the connection on mismatch —
do not proceed.

---

## 2. Authentication handshake

The **first** frame the client sends must be an `auth` frame. Until it is
accepted, any other frame is ignored and the socket is closed.

### Client → server: `auth`

```json
{
  "type": "auth",
  "id": "<correlation-id>",
  "token": "<shared-token>",
  "protocols": ["bat-remote/v2", "bat-remote/legacy-v1"],
  "compression": ["gzip"],
  "args": [
    "<label>",
    {
      "windowId": "<stable-window-id>",
      "clientInfo": {
        "appName": "ClaudeBot",
        "appVersion": "0.3.1",
        "deviceName": "<label>",
        "label": "<label>",
        "deviceId": "<stable-per-install-id>",
        "platform": "linux"
      }
    }
  ]
}
```

- **`token`** — the shared secret. Obtained out of band (Settings → Remote / QR).
  A wrong token gets `{"type":"auth-result","error":"Invalid token"}` and the
  socket closes.
- **`protocols`** — negotiation list. The server prefers `bat-remote/v2`, falls
  back to `bat-remote/legacy-v1`. An empty/omitted list defaults to legacy v1; an
  unknown-only list is rejected (`Unsupported remote protocol`). **Offer
  `bat-remote/v2`** so you can use named `params` instead of positional `args`.
- **`compression`** — optional opt-in. `["gzip"]` enables gzip; omit it (or send
  `["none"]`) to keep every post-auth frame as plain-text JSON. **The PoC omits
  it** to stay dependency-free. See §6.
- **`args[0]`** — a human label shown in the host's connected-clients list.
- **`args[1].windowId`** — a stable id for this client "window". Keep it constant
  for the life of the connection (see §5 on event routing).
- **`args[1].clientInfo.deviceId`** — a stable per-install id. The host dedupes
  its "new client connected" notification on it, so a reconnecting client stays
  silent instead of re-notifying.

### Server → client: `auth-result`

Success:

```json
{
  "type": "auth-result",
  "id": "<same correlation-id>",
  "result": true,
  "protocol": "bat-remote/v2",
  "compression": "none",
  "serverVersion": "3.2.0",
  "capabilities": { "remoteAuth": { "claude": "paste-code-v1", "codex": "device-code-v1" } }
}
```

Failure: `{ "type": "auth-result", "id": ..., "error": "<reason>" }` and the
socket closes.

- **`protocol` / `compression`** — the negotiated values; use exactly these for
  all subsequent frames.
- **`serverVersion`** — the host app version (may be **absent** on hosts older
  than the version handshake). Compare against your own expectation to warn on
  skew. The `auth-result` frame itself is always sent **uncompressed**.
- **`capabilities`** — additive feature advertisement; missing against older
  hosts. Treat unknown/absent keys as "not supported".

---

## 3. Frame envelope

All frames are JSON objects (see §6 for the gzip binary variant). Frames are
correlated by a client-chosen **`id`** (any unique string).

| Direction | `type` | Purpose |
|---|---|---|
| C→S | `auth` | Authenticate (first frame only) |
| C→S | `ping` | App-level keepalive → server replies `pong` |
| C→S | `invoke` | Call a host method (request/response) |
| S→C | `auth-result` | Result of `auth` |
| S→C | `pong` | Reply to `ping` |
| S→C | `invoke-result` | Success reply to an `invoke` (`{id, result}`) |
| S→C | `invoke-error` | Failure reply to an `invoke` (`{id, error}`) |
| S→C | `event` | Host-broadcast state change (see §5) |

WebSocket-level `ping`/`pong` also flow (the host pings idle connections every
~20s); a `ws` client answers control pings automatically.

---

## 4. Invoking host methods

### Client → server: `invoke`

```json
{
  "type": "invoke",
  "id": "<correlation-id>",
  "channel": "agent:send-message",
  "params": { "sessionId": "s-1", "prompt": "hello" },
  "args": []
}
```

- **`channel`** — the host method. Channels are namespaced: `agent:*`, `claude:*`,
  `pty:*`, `app:*`, `git:*`, `fs:*`, `profile:*`, `workspace:*`, etc.
  `agent:<name>` is an alias that the host canonicalizes to `claude:<name>`
  (except `agent:list-presets` and `agent:get-supported-session-types`, which stay
  as-is). Sending either the `agent:` or `claude:` form works.
- **`params`** (protocol v2) — named arguments. **Preferred.** On v2 the host uses
  `params` when present and only falls back to positional `args` if it is absent.
- **`args`** (legacy v1) — positional arguments; the host maps them to named
  params per channel (`remote_core.rs::legacy_v1_args_to_params`). Only needed if
  you negotiated legacy v1.

### Server → client

```json
{ "type": "invoke-result", "id": "<correlation-id>", "result": <value> }
```
or
```json
{ "type": "invoke-error", "id": "<correlation-id>", "error": "<message>" }
```

Match the reply to your pending request by `id`.

---

## 5. Sending a message and receiving the streamed reply

This is the core flow for a **Claude SDK agent** session. (Codex sessions use the
same channels but the host services them in Rust; Claude sessions are serviced by
the host's sidecar. `options`/`agentPreset` decide which. The PoC targets Claude.)

### Step 1 — start a session

Generate a **client-side `sessionId`** (any unique string; it is your handle for
the conversation), then:

```json
{
  "type": "invoke", "id": "1", "channel": "agent:start-session",
  "params": { "sessionId": "s-1", "options": { "cwd": "/abs/project/path", "agentPreset": "claude-agent" } }
}
```

`options` at minimum needs **`cwd`**. `agentPreset`, `model`, etc. are optional and
select the agent flavor; confirm the exact set your host expects against a live
host (`renderer/src/host-api.ts` shows the full option surface). The
`invoke-result` acknowledges the session is created.

### Step 2 — send the prompt

```json
{
  "type": "invoke", "id": "2", "channel": "agent:send-message",
  "params": { "sessionId": "s-1", "prompt": "hello" }
}
```

Full `params` for `send-message`: `sessionId`, `prompt`, `images?` (string[]),
`autoCompactWindow?` (number|null), `clientMessageId?`, `displayPrompt?`,
`suppressUserEcho?`.

> **The `invoke-result` for `send-message` is only an ACK** that the host accepted
> the prompt. The model's output does **not** come back on this response — it
> arrives as a series of **`event`** frames (below). **Turn completion is signaled
> by the `agent:turn-end` event, not by the invoke-result.** A driver that
> resolves on the invoke-result finishes far too early.

### Step 3 — consume broadcast events

The host broadcasts `event` frames to every connected client:

```json
{ "type": "event", "channel": "agent:stream", "params": { "sessionId": "s-1", "data": { "text": "he" } }, "args": ["s-1", { "text": "he" }] }
```

Read `params` (v2). If absent, reconstruct from `args` using the per-channel
mapping (`remote_core.rs::legacy_v1_event_args_to_params`). **The server sends all
broadcasts to all clients, so filter by your `sessionId`.**

Session event channels (wire form uses `agent:`; canonical form is `claude:`):

| Channel (`agent:` / `claude:`) | `params` shape | Meaning |
|---|---|---|
| `stream` | `{ sessionId, data }` | Incremental delta. `data` carries `{text}` or `{thinking}`; **append** deltas. |
| `message` | `{ sessionId, message }` | A complete message object (assistant/user/system). |
| `tool-use` | `{ sessionId, toolCall }` | The agent invoked a tool. |
| `tool-result` | `{ sessionId, result }` | A tool returned. |
| `turn-end` | `{ sessionId, payload }` | **Turn complete** — resolve the turn here. |
| `result` | `{ sessionId, result }` | Final turn result/usage summary. |
| `error` | `{ sessionId, error }` | Turn failed. |
| `status` | `{ sessionId, meta }` | Status/metadata update. |
| `permission-request` / `ask-user` | `{ sessionId, data }` | Host is asking the client to resolve a permission / question (see risks). |

The full proxied-event set is `remote_core.rs::is_proxied_remote_event`. Events not
in that set are not forwarded.

> **Stream coalescing.** The server **buffers `stream` and `tool-result` events
> for ~1s** and merges consecutive `stream` deltas for the same session
> (`remote_server.rs`: `REMOTE_EVENT_BUFFER_FLUSH`, `merge_buffered_stream_params`).
> So deltas arrive in ~1s batches with `text`/`thinking` concatenated, and the
> buffer is flushed immediately before a `message`/`turn-end`/`result`/`error`.
> Treat each `stream.data.text` as an increment to append; don't assume one event
> per token.

### Other useful channels

- `agent:get-session-state` `{sessionId}` — current transcript/state snapshot.
- `agent:client-resume` / `agent:resume-session` — re-attach to an existing
  session and have the host re-emit its history (for reconnect).
- `agent:stop-session`, `agent:abort-session`, `agent:interrupt-turn` `{sessionId}`.
- `agent:auth-status`, `agent:account-list` — auth/account info.
- `app:get-version` — `{version, protocol}`.

---

## 6. Compression (optional)

If you offer `"compression":["gzip"]` and the host accepts, **every post-auth
frame** (both directions) becomes a **binary** WebSocket message:

```
[ "BATGZIP1\0" (9-byte magic) ][ gzip(JSON bytes) ]
```

(`remote_core.rs`: `REMOTE_GZIP_FRAME_MAGIC`, `encode_remote_frame`.) The
`auth`/`auth-result` frames are always plain text regardless. To stay simple and
zero-dependency, **do not offer gzip** — the host then keeps everything as text
JSON. The PoC takes this path.

---

## 7. Version & capability compatibility

- **`auth-result.serverVersion`** — compare to your expectation; absent on
  pre-handshake hosts. A silent client/server skew previously caused shared-state
  corruption (BAT issue #115), so surface a warning on mismatch.
- **`auth-result.capabilities`** — additive; treat missing keys as unsupported.
- **`app:get-version`** invoke also returns `{version, protocol}`.

---

## 8. Risks & gotchas (read before implementing)

1. **Fingerprint pinning is required.** Without the host's SHA-256 cert
   fingerprint (obtained out of band) the client cannot safely connect. `ws` needs
   `rejectUnauthorized:false` **plus** a manual `fingerprint256` check on the
   `upgrade` socket — reject on mismatch.
2. **Turn completion = `agent:turn-end` event**, not the `send-message`
   invoke-result (which is just an ACK). Wire completion to the event; guard with
   an overall timeout in case a `turn-end` never arrives.
3. **Host-owned state.** Never optimistically render final state. Send the request,
   then render the host's response / broadcast. Loading UI while waiting is fine.
4. **Filter events by `sessionId`.** All broadcasts reach all clients. (The
   `event_owner` routing in `remote_client.rs` is BAT-as-client internal fan-out;
   an external client just receives everything and must filter.)
5. **`windowId` must be stable** for the connection. It ties the connection to a
   logical window on the host side; changing it mid-connection can desync
   workspace/session ownership.
6. **Stream deltas are coalesced (~1s) and merged.** Append, don't count events.
7. **Token rotation revokes the connection.** If the host rotates its token, the
   server force-closes existing clients. The client sees the socket close and must
   re-auth with the new token (again obtained out of band).
8. **Session lifetime is the host's.** The host keeps SDK sessions alive
   independent of client connections, so you can reconnect and `send-message` to
   the same `sessionId`. But if the **host restarts**, the session is gone —
   `send-message` will fail and you must `start-session` again. Calling
   `start-session` on an already-live `sessionId` may reset it; prefer
   `client-resume`/`resume-session` to re-attach.
9. **Interactive prompts.** Some sessions emit `permission-request` / `ask-user`
   events expecting the client to reply (`agent:resolve-permission` /
   `agent:resolve-ask-user`). A non-interactive bot should either run a session
   preset that won't prompt (e.g. auto-approve) or handle these channels, or turns
   can stall waiting for an answer.
10. **Codex vs Claude.** Same channels, different host servicing. Codex
    `start-session`/`resume-session` return session state from Rust; Claude routes
    to the sidecar. Pick the agent via `options`/`agentPreset` and don't assume one
    backend's response shape for the other.

---

## 9. Credential distribution via ClaudeBot pairing code

Copying the URL / token / fingerprint by hand is error-prone. ClaudeBot layers a
one-time **pairing code** over its own relay so a new machine can fetch the whole
credential pack automatically. **BAT is not involved in this — it's purely
ClaudeBot infrastructure.**

**Config precedence (same driver, two sources):** the `bat-remote` backend reads
`BAT_REMOTE_URL` / `BAT_REMOTE_TOKEN` / `BAT_REMOTE_FINGERPRINT` from **env
first**; if unset it falls back to **`data/bat-remote.json`**. The host machine
running BAT uses env; a paired machine uses the file.

**Flow (user's view):**

1. **On the host** (the machine whose ClaudeBot has `BAT_REMOTE_*` in `.env`):
   send `/pair bat` in Telegram. The bot replies with a ready-to-paste command
   containing the relay URL and a code, e.g.
   `npx tsx src/remote/join-bat.ts ws://host:9877 482913`.
2. **On the new machine** (its own ClaudeBot checkout): paste and run that
   command. `join-bat` connects to the relay, sends `bat_credentials_request`
   with the code, receives the `{url, token, fingerprint, cwdDefault?}` pack, and
   writes it to `data/bat-remote.json` (best-effort `0600`).
3. Switch that project's AI backend to `bat-remote`. The driver picks up the file
   automatically — no env vars, no manual copying.

**Relay wire messages** (`src/remote/protocol.ts`): client→relay
`{type:"bat_credentials_request", code}`; relay→client
`{type:"bat_credentials", url, token, fingerprint, cwdDefault?}` or
`{type:"error", error}`. It is a short-lived request/response — the relay closes
the socket right after replying.

**Security model:**

- The credential pack **transits the ClaudeBot relay** and therefore inherits the
  relay's trust boundary. Run the relay on a trusted network (**LAN**) or behind
  **wss/TLS** (e.g. Cloudflare Tunnel). Anyone who can reach the relay *and*
  holds a live code can obtain the pack.
- Codes are **one-time and TTL-bounded (5 minutes)**. `consumeBatCode` deletes a
  valid `bat` code on first redemption, so a leaked/replayed code is inert.
  Non-`bat` (agent) codes are never consumed by a bat request.
- Invalid-code attempts are rate-limited per IP (shared with the relay's existing
  limiter). The host only issues a code when its own `BAT_REMOTE_*` env is set,
  so a code can always be redeemed while it lives.
- `data/bat-remote.json` holds the token + fingerprint in clear; `data/` is
  gitignored. Treat it as a secret (the writer restricts perms to `0600` where the
  OS honors it).
