import { describe, it, expect } from 'vitest'
import { detectParallelCandidate } from '../../src/utils/parallel-detector.js'

describe('detectParallelCandidate', () => {
  it('returns null for very long text', () => {
    expect(detectParallelCandidate('x'.repeat(2001))).toBeNull()
  })

  it('returns null when an analysis/exclusion keyword is present', () => {
    expect(detectParallelCandidate('比較 React 和 Vue 的差異')).toBeNull()
  })

  it('detects a numbered list as high confidence', () => {
    const r = detectParallelCandidate('1. 修 login bug\n2. 加 dark mode\n3. 寫 readme')
    expect(r?.confidence).toBe('high')
    expect(r?.tasks).toHaveLength(3)
  })

  it('detects a bullet list as high confidence', () => {
    const r = detectParallelCandidate('- build the api\n- build the ui')
    expect(r?.confidence).toBe('high')
    expect(r?.tasks).toHaveLength(2)
  })

  it('detects multi-task keyword + line breaks as medium confidence', () => {
    const r = detectParallelCandidate('幫我做登入頁面\n幫我做註冊頁面')
    expect(r?.confidence).toBe('medium')
    expect(r?.tasks?.length).toBeGreaterThanOrEqual(2)
  })

  it('returns null for a single task', () => {
    expect(detectParallelCandidate('幫我修一個 login bug')).toBeNull()
  })
})
