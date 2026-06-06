import { describe, it, expect } from 'vitest'
import { detectChoices } from '../../src/utils/choice-detector.js'

describe('detectChoices', () => {
  it('returns none for empty text', () => {
    expect(detectChoices('').type).toBe('none')
    expect(detectChoices('   ').type).toBe('none')
  })

  it('options WITH a selection prompt → options', () => {
    const r = detectChoices('要做哪個？\n1. 修 bug\n2. 加功能')
    expect(r.type).toBe('options')
    expect(r.choices).toHaveLength(2)
  })

  it('numbered list WITHOUT a selection prompt → none (just an explanation)', () => {
    const r = detectChoices('我做了：\n1. 修改了 X\n2. 新增了 Y')
    expect(r.type).toBe('none')
  })

  it('past-tense explanation markers block options even with 2 items', () => {
    const r = detectChoices('結果：\n1. 已完成 A\n2. 已經處理 B')
    expect(r.type).toBe('none')
  })

  it('yes/no question (Chinese) → yesno with 是/否', () => {
    const r = detectChoices('我可以開始實作了。要繼續嗎？')
    expect(r.type).toBe('yesno')
    expect(r.choices).toHaveLength(2)
  })

  it('yes/no question (English) → yesno', () => {
    expect(detectChoices('Should I proceed?').type).toBe('yesno')
  })

  it('open-ended question → open (no buttons)', () => {
    expect(detectChoices('你覺得怎樣？').type).toBe('open')
  })

  it('a single option is not enough (needs >= 2) → none', () => {
    expect(detectChoices('1. only one item here').type).toBe('none')
  })

  it('truncates a long option label but keeps the full value', () => {
    const long = 'x'.repeat(50)
    const r = detectChoices(`要選哪個？\n1. ${long}\n2. short`)
    expect(r.type).toBe('options')
    const first = r.choices[0]
    expect(first.label.endsWith('…')).toBe(true)
    expect(first.value).toBe(long)
  })
})
