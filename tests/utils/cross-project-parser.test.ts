import { describe, it, expect } from 'vitest'
import {
  parseCrossProjectTasks,
  stripRunDirectives,
} from '../../src/utils/cross-project-parser.js'

// A name no project directory can match, so findProject() must return null.
const MISSING = 'zzz-no-such-project-zzz'

describe('parseCrossProjectTasks', () => {
  it('keeps an unresolvable directive instead of dropping it silently', () => {
    const tasks = parseCrossProjectTasks(`@run(${MISSING}) 修一下付款頁`)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].project).toBeNull()
    expect(tasks[0].projectName).toBe(MISSING)
    expect(tasks[0].prompt).toBe('修一下付款頁')
  })

  it('resolves a real project', () => {
    // ClaudeBot itself is always inside PROJECTS_BASE_DIR
    const tasks = parseCrossProjectTasks('@run(ClaudeBot) 跑測試')
    expect(tasks).toHaveLength(1)
    expect(tasks[0].project).not.toBeNull()
    expect(tasks[0].prompt).toBe('跑測試')
  })

  it('reports every directive, resolvable or not, in order', () => {
    const tasks = parseCrossProjectTasks(
      ['@run(ClaudeBot) 第一件', `@run(${MISSING}) 第二件`].join('\n'),
    )
    expect(tasks).toHaveLength(2)
    expect(tasks[0].project).not.toBeNull()
    expect(tasks[1].project).toBeNull()
  })

  it('ignores a directive with no task text', () => {
    expect(parseCrossProjectTasks('@run(ClaudeBot)')).toHaveLength(0)
  })

  it('ignores an empty project name', () => {
    expect(parseCrossProjectTasks('@run() 做點事')).toHaveLength(0)
  })

  it('only matches at the start of a line', () => {
    expect(parseCrossProjectTasks('see @run(ClaudeBot) 做點事')).toHaveLength(0)
  })
})

describe('stripRunDirectives', () => {
  it('strips resolvable and unresolvable directives alike', () => {
    const text = ['做完了。', '@run(ClaudeBot) 甲', `@run(${MISSING}) 乙`, '結束。'].join('\n')
    const out = stripRunDirectives(text)
    expect(out).not.toContain('@run(')
    expect(out).toContain('做完了。')
    expect(out).toContain('結束。')
  })

  it('leaves text without directives untouched', () => {
    expect(stripRunDirectives('沒有指令')).toBe('沒有指令')
  })
})
