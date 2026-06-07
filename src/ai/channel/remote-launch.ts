import { env } from '../../config/env.js'
import { getSystemPrompt } from '../../utils/system-prompt.js'
import { getPairing } from '../../remote/pairing-store.js'
import { getActiveMachine } from '../../bot/state.js'
import { isVirtualChat, getVirtualChatPairingCode, getVirtualChatLicenseKey } from '../../remote/virtual-chat-store.js'
import { isAdminLicense } from '../../remote/license-store.js'
import { getRelayPort, getAgentBaseDir } from '../../remote/relay-server.js'
import { generateRemoteMcpConfig, cleanupRemoteMcpConfig } from '../../remote/mcp-config-generator.js'
import { buildRemoteSystemBlock } from '../../claude/claude-runner.js'
import { computeFingerprint } from './fingerprint.js'
import type { SessionLaunchConfig } from './types.js'

export interface ChannelLaunch {
  readonly cfg: SessionLaunchConfig
  readonly fingerprint: string
}

/**
 * Build the SessionLaunchConfig + fingerprint for a channel turn. Handles both
 * LOCAL projects (cwd = project path) and REMOTE-paired sessions (cwd = bot
 * host, remote_* MCP + remote system block + disallowedTools, like the -p path).
 */
export function resolveChannelLaunch(opts: {
  readonly projectPath: string
  readonly model: string
  readonly chatId?: number
  readonly threadId?: number
  readonly maxTurns?: number
}): ChannelLaunch {
  const base = getSystemPrompt()

  // Determine remote-ness exactly like claude-runner's isRemoteSession.
  const activeMachine = opts.chatId ? getActiveMachine(opts.chatId, opts.threadId) : undefined
  const pairing = (env.REMOTE_ENABLED && opts.chatId != null)
    ? getPairing(opts.chatId, opts.threadId, activeMachine) : null
  const isRemote = opts.chatId != null && (
    pairing?.connected === true || isVirtualChat(opts.chatId)
  )

  if (!isRemote) {
    return {
      cfg: {
        cwd: opts.projectPath,
        model: opts.model,
        systemPrompt: base,
        mcpConfigPaths: [],
        maxTurns: opts.maxTurns,
      },
      fingerprint: computeFingerprint({
        model: opts.model,
        pairingCode: null,
        isAdmin: false,
        browser: false,
        systemPromptVersion: 1,
      }),
    }
  }

  // Remote: resolve code + admin + baseDir like claude-runner does.
  let remoteCode: string | null = null
  if (pairing?.connected) {
    remoteCode = pairing.code
  } else if (opts.chatId != null && isVirtualChat(opts.chatId)) {
    remoteCode = getVirtualChatPairingCode(opts.chatId)
  }

  const isAdmin = env.ADMIN_CHAT_ID === opts.chatId ||
    (opts.chatId != null && isVirtualChat(opts.chatId) &&
      isAdminLicense(getVirtualChatLicenseKey(opts.chatId) ?? ''))

  const remoteBaseDir = remoteCode != null ? getAgentBaseDir(remoteCode) : undefined
  const systemBlock = buildRemoteSystemBlock(isAdmin, remoteBaseDir, !!env.MCP_AGENT_BROWSER)
  const systemPrompt = base ? `${base}\n\n${systemBlock}` : systemBlock

  const mcpPaths: string[] = []
  let generated: string | null = null
  if (remoteCode != null) {
    const port = getRelayPort() || env.RELAY_PORT
    generated = generateRemoteMcpConfig(port, remoteCode)
    mcpPaths.push(generated)
  }

  const disallowedTools: string[] | undefined = isAdmin
    ? undefined
    : ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep', 'NotebookEdit']

  return {
    cfg: {
      cwd: process.cwd(),
      model: opts.model,
      systemPrompt,
      mcpConfigPaths: mcpPaths,
      disallowedTools,
      maxTurns: opts.maxTurns,
      cleanup: generated != null
        ? () => { cleanupRemoteMcpConfig(generated as string) }
        : undefined,
    },
    fingerprint: computeFingerprint({
      model: opts.model,
      pairingCode: remoteCode,
      isAdmin,
      browser: !!env.MCP_AGENT_BROWSER,
      systemPromptVersion: 1,
    }),
  }
}
