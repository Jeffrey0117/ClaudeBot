import { describe, it, expect } from 'vitest'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { createPathValidator } from '../../src/remote/tool-handlers/path-validator.js'

const baseDir = join(homedir(), 'projects', 'app-under-test')
const validate = createPathValidator(baseDir)

describe('createPathValidator', () => {
  it('resolves a relative path inside the base dir', () => {
    expect(validate('src/index.ts')).toBe(resolve(baseDir, 'src/index.ts'))
  })

  it('blocks a relative path that escapes the base dir', () => {
    expect(() => validate('../../../../../../etc/passwd')).toThrow(/traversal/i)
  })

  it('blocks UNC paths', () => {
    expect(() => validate('\\\\server\\share\\x')).toThrow(/UNC/i)
    expect(() => validate('//server/share/x')).toThrow(/UNC/i)
  })

  it('blocks an absolute path outside both home and base', () => {
    const outside = resolve(homedir(), '..', 'someone-else', 'secret.txt')
    expect(() => validate(outside)).toThrow()
  })

  it('allows an absolute path that IS inside the base dir', () => {
    const inside = join(baseDir, 'data', 'file.json')
    expect(validate(inside)).toBe(resolve(inside))
  })
})
