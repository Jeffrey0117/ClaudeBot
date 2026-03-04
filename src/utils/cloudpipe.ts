/**
 * CloudPipe Gateway Client
 *
 * Calls CloudPipe's internal gateway API to invoke any registered tool.
 * Supports:
 *   - Gateway tools (POST /api/gateway/call)
 *   - Tool discovery (GET /api/gateway/tools)
 *   - Pipelines (POST /api/gateway/pipeline)
 */

import { env } from '../config/env.js'

// --- Types ---

export interface CloudPipeTool {
  readonly name: string
  readonly project: string
  readonly method: string
  readonly path: string
  readonly description: string
}

export interface ToolCallResult {
  readonly ok: boolean
  readonly status?: number
  readonly data?: unknown
  readonly error?: string
}

export interface PipelineResult {
  readonly ok: boolean
  readonly steps: unknown[]
  readonly error?: string
}

// --- Cache ---

interface CacheEntry {
  readonly result: ToolCallResult
  readonly timestamp: number
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const cache = new Map<string, CacheEntry>()

function getCacheKey(tool: string, params?: Record<string, unknown>): string {
  return `${tool}:${JSON.stringify(params || {})}`
}

function getCachedResult(tool: string, params?: Record<string, unknown>): ToolCallResult | null {
  const key = getCacheKey(tool, params)
  const entry = cache.get(key)

  if (!entry) return null

  const age = Date.now() - entry.timestamp
  if (age > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }

  return entry.result
}

function setCachedResult(tool: string, params: Record<string, unknown> | undefined, result: ToolCallResult): void {
  const key = getCacheKey(tool, params)
  cache.set(key, { result, timestamp: Date.now() })
}

// Clean up old cache entries periodically
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      cache.delete(key)
    }
  }
}, 60 * 1000) // Every minute

// --- API Client ---

class CloudPipeClient {
  private readonly baseUrl: string
  private readonly serviceToken: string

  constructor(baseUrl: string, serviceToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '') // Remove trailing slash
    this.serviceToken = serviceToken
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.serviceToken) {
      headers['Authorization'] = `Bearer ${this.serviceToken}`
    }
    return headers
  }

  /**
   * List all available gateway tools
   */
  async listTools(project?: string): Promise<CloudPipeTool[]> {
    const url = new URL('/api/gateway/tools', this.baseUrl)
    if (project) {
      url.searchParams.set('project', project)
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: this.getHeaders(),
    })

    if (!res.ok) {
      throw new Error(`Failed to list tools: ${res.status} ${res.statusText}`)
    }

    const json = (await res.json()) as { tools: CloudPipeTool[]; total: number }
    return json.tools
  }

  /**
   * Call a gateway tool by name with retry support
   */
  async callTool(
    tool: string,
    params?: Record<string, unknown>,
    options?: { retries?: number; retryDelay?: number }
  ): Promise<ToolCallResult> {
    const maxRetries = options?.retries ?? 2
    const retryDelay = options?.retryDelay ?? 1000

    let lastError: string | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const url = new URL('/api/gateway/call', this.baseUrl)

        const res = await fetch(url.toString(), {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({ tool, params: params || {} }),
        })

        const json = (await res.json()) as ToolCallResult

        const result = {
          ok: json.ok,
          status: res.status,
          data: json.data,
          error: json.error,
        }

        // Only retry on network errors or 5xx server errors
        if (result.ok || (result.status && result.status < 500)) {
          return result
        }

        lastError = result.error || `HTTP ${result.status}`
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }

      // Wait before retrying (except on last attempt)
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)))
      }
    }

    return {
      ok: false,
      error: `Failed after ${maxRetries + 1} attempts: ${lastError}`,
    }
  }

  /**
   * Run a pipeline by name
   */
  async runPipeline(pipeline: string, input: unknown): Promise<PipelineResult> {
    const url = new URL('/api/gateway/pipeline', this.baseUrl)

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ pipeline, input }),
    })

    if (!res.ok) {
      const text = await res.text()
      return {
        ok: false,
        steps: [],
        error: `Pipeline failed: ${res.status} ${text}`,
      }
    }

    const json = (await res.json()) as PipelineResult
    return json
  }

  /**
   * List all available pipelines
   */
  async listPipelines(): Promise<string[]> {
    const url = new URL('/api/gateway/pipelines', this.baseUrl)

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: this.getHeaders(),
    })

    if (!res.ok) {
      throw new Error(`Failed to list pipelines: ${res.status} ${res.statusText}`)
    }

    const json = (await res.json()) as { pipelines: string[] }
    return json.pipelines
  }
}

// --- Singleton instance ---

let clientInstance: CloudPipeClient | null = null

export function getCloudPipeClient(): CloudPipeClient | null {
  if (!env.CLOUDPIPE_URL) {
    return null
  }

  if (!clientInstance) {
    clientInstance = new CloudPipeClient(env.CLOUDPIPE_URL, env.CLOUDPIPE_SERVICE_TOKEN)
  }

  return clientInstance
}

/**
 * Quick helper: call a tool with caching and retry
 */
export async function callCloudPipeTool(
  tool: string,
  params?: Record<string, unknown>,
  options?: { useCache?: boolean; retries?: number }
): Promise<ToolCallResult> {
  const client = getCloudPipeClient()
  if (!client) {
    return {
      ok: false,
      error: 'CloudPipe not configured (CLOUDPIPE_URL missing)',
    }
  }

  // Check cache first (default: enabled)
  if (options?.useCache !== false) {
    const cached = getCachedResult(tool, params)
    if (cached) {
      return cached
    }
  }

  // Call with retry
  const result = await client.callTool(tool, params, { retries: options?.retries })

  // Cache successful results
  if (result.ok && options?.useCache !== false) {
    setCachedResult(tool, params, result)
  }

  return result
}

/**
 * Quick helper: list all tools
 */
export async function listCloudPipeTools(project?: string): Promise<CloudPipeTool[]> {
  const client = getCloudPipeClient()
  if (!client) {
    return []
  }

  return client.listTools(project)
}
