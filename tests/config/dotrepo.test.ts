import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDotRepo, formatDotRepoIntro, formatDotRepoDetail } from '../../src/config/dotrepo.js'

let dir = ''

function repoWith(content: string | null): string {
  dir = mkdtempSync(join(tmpdir(), 'dotrepo-'))
  if (content !== null) writeFileSync(join(dir, '.repo'), content, 'utf-8')
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('readDotRepo', () => {
  it('returns null when the project has no .repo', () => {
    expect(readDotRepo(repoWith(null))).toBeNull()
  })

  it('returns null for a .repo that is not valid JSON', () => {
    expect(readDotRepo(repoWith('{ not json'))).toBeNull()
  })

  it('returns null when .repo has no usable "what"', () => {
    expect(readDotRepo(repoWith(JSON.stringify({ repo: 1, name: 'x' })))).toBeNull()
  })

  it('returns null for remote projects without touching the disk', () => {
    expect(readDotRepo('remote:some-project')).toBeNull()
  })

  it('reads identity, work commands and offers', () => {
    const summary = readDotRepo(
      repoWith(
        JSON.stringify({
          repo: 1,
          name: 'pokkit',
          what: 'Throw a file in, get a short link',
          kind: 'service',
          status: 'live',
          work: { guide: 'CLAUDE.md', run: 'npm run dev', test: 'npm test' },
          offers: [
            { id: 'upload_file', how: 'http', what: 'Upload a file' },
            { id: 'client', how: 'import', what: 'Node client' },
          ],
          uses: ['letmeuse'],
        }),
      ),
    )

    expect(summary).toEqual({
      name: 'pokkit',
      what: 'Throw a file in, get a short link',
      kind: 'service',
      status: 'live',
      run: 'npm run dev',
      test: 'npm test',
      offers: [
        { id: 'upload_file', how: 'http', what: 'Upload a file' },
        { id: 'client', how: 'import', what: 'Node client' },
      ],
      uses: ['letmeuse'],
    })
  })

  it('tolerates a UTF-8 BOM and missing optional sections', () => {
    const summary = readDotRepo(repoWith('﻿' + JSON.stringify({ repo: 1, what: 'A thing' })))
    expect(summary?.what).toBe('A thing')
    expect(summary?.offers).toEqual([])
    expect(summary?.uses).toEqual([])
  })
})

describe('formatDotRepoIntro', () => {
  it('is empty when there is no .repo, so callers can append it blindly', () => {
    expect(formatDotRepoIntro(null)).toBe('')
  })

  it('shows what the project is and how much it offers', () => {
    const text = formatDotRepoIntro({
      name: 'pokkit',
      what: 'Throw a file in, get a short link',
      kind: 'service',
      status: 'live',
      run: '',
      test: '',
      offers: [{ id: 'a', how: 'http', what: 'x' }],
      uses: [],
    })
    expect(text).toContain('Throw a file in, get a short link')
    expect(text).toContain('service')
    expect(text).toContain('1')
  })

  it('escapes Telegram Markdown control characters in the description', () => {
    const text = formatDotRepoIntro({
      name: 'x',
      what: 'uses_snake *stars* [link] `tick`',
      kind: '',
      status: '',
      run: '',
      test: '',
      offers: [],
      uses: [],
    })
    expect(text).toContain('uses\\_snake \\*stars\\* \\[link] \\`tick\\`')
  })
})

describe('formatDotRepoDetail', () => {
  it('lists offers and escapes HTML', () => {
    const text = formatDotRepoDetail('pokkit', {
      name: 'pokkit',
      what: 'Files <fast>',
      kind: 'service',
      status: 'live',
      run: 'npm run dev',
      test: 'npm test',
      offers: [{ id: 'upload_file', how: 'http', what: 'Upload & share' }],
      uses: ['letmeuse'],
    })
    expect(text).toContain('Files &lt;fast&gt;')
    expect(text).toContain('upload_file')
    expect(text).toContain('Upload &amp; share')
    expect(text).toContain('npm run dev')
    expect(text).toContain('letmeuse')
  })

  it('caps a long offers list and says how many were left out', () => {
    const offers = Array.from({ length: 30 }, (_, i) => ({ id: `tool_${i}`, how: 'http', what: 'does a thing' }))
    const text = formatDotRepoDetail('big', {
      name: 'big',
      what: 'Big',
      kind: '',
      status: '',
      run: '',
      test: '',
      offers,
      uses: [],
    })
    expect(text).toContain('tool_0')
    expect(text).not.toContain('tool_29')
    expect(text).toContain('18')
  })
})
