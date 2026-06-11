import { describe, it, expect } from 'vitest'
import { jarvisPage } from '../../src/jarvis/page.js'

/**
 * Extract the real sanitize() (and its FENCE helpers) from the generated page
 * and execute it — template-literal escaping bugs change regex behavior in
 * ways a syntax check can't catch.
 */
function loadSanitize(): (s: string) => string {
  const script = jarvisPage().match(/<script>([\s\S]*?)<\/script>/)![1]
  const fence = script.match(/const FENCE = [^\n]+/)![0]
  const fencePair = script.match(/const fencePair = [^\n]+/)![0]
  const fn = script.match(/function sanitize\(s\) \{[\s\S]*?\n  \}/)![0]
  return new Function(`${fence}\n${fencePair}\n${fn}\nreturn sanitize`)() as (s: string) => string
}

describe('page sanitize (speech text cleaner)', () => {
  const sanitize = loadSanitize()

  it('strips complete CTX blocks', () => {
    expect(sanitize('好了。[CTX]status: done[/CTX]')).toBe('好了。')
  })

  it('cuts at a half-streamed CTX block', () => {
    expect(sanitize('好了。[CTX]status: do')).toBe('好了。')
  })

  it('strips @directives', () => {
    expect(sanitize('開好了 @notify(完成) 喔')).toBe('開好了  喔')
  })

  it('removes complete code fences', () => {
    expect(sanitize('看這個```js\nconst x = 1\n```就懂')).toBe('看這個就懂')
  })

  it('holds at an unclosed code fence', () => {
    expect(sanitize('看這個```js\nconst x =')).toBe('看這個')
  })

  it('passes plain speech through untouched', () => {
    expect(sanitize('我幫你開 YouTube 了,瀏覽器應該跳出來了。')).toBe('我幫你開 YouTube 了,瀏覽器應該跳出來了。')
  })
})
