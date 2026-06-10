import { describe, it, expect } from 'vitest'
import { jarvisPage } from '../../src/jarvis/page.js'

describe('jarvisPage', () => {
  const html = jarvisPage()

  it('is a complete HTML document', () => {
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('</html>')
  })

  it('has the four-state machine wired to body[data-state]', () => {
    for (const state of ['idle', 'listening', 'thinking', 'speaking']) {
      expect(html).toContain(`data-state="${state}"`)
    }
  })

  it('uses Web Speech APIs (recognition + synthesis), zh-TW', () => {
    expect(html).toContain('webkitSpeechRecognition')
    expect(html).toContain('speechSynthesis')
    expect(html).toContain('zh-TW')
  })

  it('reuses the page token for the WebSocket connection', () => {
    expect(html).toContain("get('token')")
    expect(html).toContain('/ws?token=')
  })

  it('has fullscreen support', () => {
    expect(html).toContain('requestFullscreen')
  })

  it('escapes server text before injecting into innerHTML', () => {
    expect(html).toContain('&amp;')
    expect(html).toContain('&lt;')
  })
})
