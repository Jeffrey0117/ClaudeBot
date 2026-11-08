import { findProject } from '../config/projects.js'
import type { ProjectInfo } from '../types/index.js'

export interface CrossProjectTask {
  /** null when the name could not be resolved to a project. */
  readonly project: ProjectInfo | null
  /** The name exactly as the AI wrote it, for reporting failures back. */
  readonly projectName: string
  readonly prompt: string
  readonly raw: string
}

const RUN_PATTERN = /^@run\(([^)]+)\)\s+(.+)$/gm

/**
 * Parse every `@run(project) task` directive, resolved or not.
 *
 * Unresolvable directives are returned with `project: null` rather than
 * dropped. They used to be skipped silently while stripRunDirectives() removed
 * the line from the reply regardless — so a delegation to a misspelled or
 * out-of-scan-path project vanished with no trace, and the user read a reply
 * implying the work had been handed off. findProject() also returns null for
 * *ambiguous* prefixes, so a plausible name can resolve to nothing.
 */
export function parseCrossProjectTasks(text: string): readonly CrossProjectTask[] {
  const tasks: CrossProjectTask[] = []
  let match: RegExpExecArray | null

  // Reset lastIndex for global regex
  RUN_PATTERN.lastIndex = 0

  while ((match = RUN_PATTERN.exec(text)) !== null) {
    const projectName = match[1].trim()
    const prompt = match[2].trim()

    if (!projectName || !prompt) continue

    tasks.push({
      project: findProject(projectName),
      projectName,
      prompt,
      raw: match[0],
    })
  }

  return tasks
}

export function stripRunDirectives(text: string): string {
  return text.replace(/^@run\([^)]+\)\s+.+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}
