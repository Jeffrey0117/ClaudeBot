import { findProject } from '../config/projects.js'
import type { ProjectInfo } from '../types/index.js'

export interface CrossProjectTask {
  readonly project: ProjectInfo
  readonly prompt: string
  readonly raw: string
}

const RUN_PATTERN = /^@run\(([^)]+)\)\s+(.+)$/gm

export function parseCrossProjectTasks(text: string): readonly CrossProjectTask[] {
  const tasks: CrossProjectTask[] = []
  let match: RegExpExecArray | null

  // Reset lastIndex for global regex
  RUN_PATTERN.lastIndex = 0

  while ((match = RUN_PATTERN.exec(text)) !== null) {
    const projectName = match[1].trim()
    const prompt = match[2].trim()

    if (!projectName || !prompt) continue

    const project = findProject(projectName)
    if (!project) continue

    tasks.push({ project, prompt, raw: match[0] })
  }

  return tasks
}
