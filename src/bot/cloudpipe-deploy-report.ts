import { execFileSync } from 'node:child_process'
import { listProjects, getProject, isParasite } from './cloudpipe-client.js'
import type { AutoCommitResult } from '../utils/auto-commit.js'

/**
 * After an auto-commit, tell the user whether the change actually reached the
 * LIVE (CloudPipe) version — the #1 confusion was "bot edited, nothing happened
 * online". For a CloudPipe-registered project we poll the deploy status and
 * report 部署中 → 上線/失敗. For a CloudPipe project that DIDN'T push, we warn
 * loudly (that's the "edited the wrong place, won't go live" case).
 *
 * Best-effort + fire-and-forget: never throws into the queue.
 */

interface MiniTelegram {
  sendMessage(chatId: number, text: string, extra?: unknown): Promise<unknown>
}

function headCommit(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

async function findCloudPipeProject(name: string) {
  const res = await listProjects()
  if (!res.ok || !res.data) return null
  const lc = name.toLowerCase()
  return (
    res.data.projects.find(
      (p) => p.id.toLowerCase() === lc || (p.pm2Name && p.pm2Name.toLowerCase() === lc),
    ) ?? null
  )
}

export async function reportCloudPipeDeploy(
  project: { readonly name: string; readonly path: string },
  commit: AutoCommitResult,
  chatId: number,
  telegram: MiniTelegram,
  tag: string,
): Promise<void> {
  try {
    const cp = await findCloudPipeProject(project.name)
    if (!cp) return // not a CloudPipe project — the auto-commit line already said local/pushed

    const send = (t: string) =>
      telegram.sendMessage(chatId, t, { parse_mode: 'Markdown' }).catch(() => {})

    if (!commit.pushed) {
      await send(
        `⚠️ *[${tag}]* \`${cp.id}\` 是 CloudPipe 專案,但**沒 push 成功**` +
          `(${commit.pushError || '沒有 remote'})→ 線上不會更新。`,
      )
      return
    }

    const hash = headCommit(project.path)

    // 轉生獸 (parasite): compute is on a remote origin (Render…) that auto-builds
    // on push. CloudPipe only routes, so it won't report a deploy status here.
    if (isParasite(cp)) {
      await send(
        `\u{1F680} *[${tag}]* \`${cp.id}\` 已 push${hash ? ` (\`${hash}\`)` : ''} ` +
          `— 由遠端 origin 自動 build(CloudPipe 不追蹤,稍候上線)。`,
      )
      return
    }

    await send(`\u{1F680} *[${tag}]* \`${cp.id}\` 已 push,CloudPipe 部署中…${hash ? ` (\`${hash}\`)` : ''}`)

    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 4000))
      const res = await getProject(cp.id)
      if (!res.ok || !res.data) continue
      const { project: p, deployments } = res.data
      const dep = hash
        ? deployments.find((d) => typeof d.commit === 'string' && d.commit.startsWith(hash))
        : deployments[0]
      const status = dep?.status || p.lastDeployStatus || ''
      if (status === 'deployed') {
        await send(`✅ *[${tag}]* \`${cp.id}\` **已上線**${hash ? ` (\`${hash}\`)` : ''}`)
        return
      }
      if (status === 'failed') {
        await send(`❌ *[${tag}]* \`${cp.id}\` **部署失敗**: ${dep?.error || '看 /ops 詳情'}`)
        return
      }
      // building / skipped / pending → keep polling
    }
    await send(`⏳ *[${tag}]* \`${cp.id}\` 部署仍進行中(逾時未確認)— 用 \`/ops ${cp.id}\` 看狀態。`)
  } catch {
    /* best-effort */
  }
}
