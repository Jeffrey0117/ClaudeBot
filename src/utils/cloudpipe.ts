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
   * Call a gateway tool by name
   */
  async callTool(tool: string, params?: Record<string, unknown>): Promise<ToolCallResult> {
    const url = new URL('/api/gateway/call', this.baseUrl)

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ tool, params: params || {} }),
    })

    const json = (await res.json()) as ToolCallResult

    return {
      ok: json.ok,
      status: res.status,
      data: json.data,
      error: json.error,
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
 * Quick helper: call a tool
 */
export async function callCloudPipeTool(
  tool: string,
  params?: Record<string, unknown>,
): Promise<ToolCallResult> {
  const client = getCloudPipeClient()
  if (!client) {
    return {
      ok: false,
      error: 'CloudPipe not configured (CLOUDPIPE_URL missing)',
    }
  }

  return client.callTool(tool, params)
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
