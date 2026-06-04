import { loadPipeConfig, pipeRequest } from '../utils/pipe-executor.js'

/**
 * Thin typed client over CloudPipe's admin API (`/api/_admin/deploy/*`).
 *
 * Lets ClaudeBot answer "is X deployed / show logs / restart / rollback"
 * directly against CloudPipe — no Claude turn, no quota, no rate-limit cooldown.
 *
 * Auth: CloudPipe's `requireAuth` accepts the shared serviceToken as an admin
 * credential for loopback callers, so `loadPipeConfig().serviceToken` is all we
 * need. Everything here is best-effort: a null/notReady result means "couldn't
 * reach CloudPipe", and callers fall back to the normal Claude pipeline.
 */

export interface CloudPipeProject {
  readonly id: string
  readonly pm2Name?: string
  readonly port?: number
  readonly runningCommit?: string | null
  readonly lastDeployCommit?: string | null
  readonly lastDeployStatus?: string | null
  readonly lastDeployAt?: string | number | null
  readonly failedCommits?: readonly string[]
  readonly disabled?: boolean
  readonly suspended?: boolean
}

export interface CloudPipeDeployment {
  readonly id?: string | number
  readonly projectId?: string
  readonly status?: string // building | deployed | failed | skipped | aborted | rolled_back
  readonly commit?: string | null
  readonly error?: string | null
  readonly startedAt?: string | number | null
  readonly finishedAt?: string | number | null
}

interface ClientResult<T> {
  readonly ok: boolean
  readonly notReady: boolean // CloudPipe config missing / unreachable
  readonly data: T | null
  readonly error?: string
}

function notReady<T>(): ClientResult<T> {
  return { ok: false, notReady: true, data: null, error: 'CloudPipe 未設定或無法連線' }
}

async function adminCall<T>(
  method: 'GET' | 'POST',
  apiPath: string,
  body?: Record<string, unknown>
): Promise<ClientResult<T>> {
  const config = loadPipeConfig()
  if (!config) return notReady<T>()

  try {
    const res = await pipeRequest(
      method,
      `${config.baseUrl}${apiPath}`,
      body,
      config.serviceToken || undefined
    )
    if (res.status === 0) return notReady<T>()
    if (!res.ok) {
      const errMsg =
        res.data && typeof res.data === 'object' && 'error' in res.data
          ? String((res.data as { error: unknown }).error)
          : `HTTP ${res.status}`
      return { ok: false, notReady: false, data: null, error: errMsg }
    }
    return { ok: true, notReady: false, data: res.data as T }
  } catch (error) {
    return {
      ok: false,
      notReady: false,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const enc = (s: string): string => encodeURIComponent(s)

/** List all registered projects with their deploy status. */
export async function listProjects(): Promise<ClientResult<{ projects: CloudPipeProject[] }>> {
  return adminCall('GET', '/api/_admin/deploy/projects')
}

/** Get one project plus its last ~10 deployments. */
export async function getProject(
  id: string
): Promise<ClientResult<{ project: CloudPipeProject; deployments: CloudPipeDeployment[] }>> {
  return adminCall('GET', `/api/_admin/deploy/projects/${enc(id)}`)
}

/** Tail PM2 logs. Keyed by pm2Name (not project id). */
export async function getLogs(pm2Name: string): Promise<ClientResult<{ logs: string }>> {
  return adminCall('GET', `/api/_admin/deploy/logs/${enc(pm2Name)}`)
}

/** Restart a project's PM2 process. */
export async function restartProject(
  id: string
): Promise<ClientResult<{ success?: boolean; message?: string }>> {
  return adminCall('POST', `/api/_admin/deploy/projects/${enc(id)}/restart`)
}

/** Roll a project back to its previous commit. */
export async function rollbackProject(
  id: string
): Promise<ClientResult<{ success?: boolean; message?: string }>> {
  return adminCall('POST', `/api/_admin/deploy/projects/${enc(id)}/rollback`)
}

/** Aggregated automation + health telemetry across the whole ecosystem. */
export async function getTelemetry(): Promise<ClientResult<Record<string, unknown>>> {
  return adminCall('GET', '/api/_admin/telemetry')
}
