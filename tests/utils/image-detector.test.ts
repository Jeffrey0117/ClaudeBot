import { describe, it, expect } from 'vitest'
import { detectImagePaths } from '../../src/utils/image-detector.js'

describe('detectImagePaths', () => {
  it('detects absolute Windows paths with image extensions', () => {
    const text = 'Screenshot saved to C:\\Users\\jeff\\app\\screenshot.png'
    const paths = detectImagePaths(text)
    expect(paths).toEqual(['C:\\Users\\jeff\\app\\screenshot.png'])
  })

  it('detects forward-slash paths', () => {
    const text = 'Image at /home/user/output/result.jpg done'
    const paths = detectImagePaths(text)
    expect(paths).toEqual(['/home/user/output/result.jpg'])
  })

  it('detects multiple image paths', () => {
    const text = 'Files: C:\\a\\one.png and C:\\b\\two.jpeg'
    const paths = detectImagePaths(text)
    expect(paths).toEqual(['C:\\a\\one.png', 'C:\\b\\two.jpeg'])
  })

  it('supports all image extensions', () => {
    const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp']
    for (const ext of extensions) {
      const text = `C:\\img\\file.${ext}`
      expect(detectImagePaths(text).length).toBe(1)
    }
  })

  it('returns empty array when no images found', () => {
    const text = 'No images here, just some text about coding.'
    expect(detectImagePaths(text)).toEqual([])
  })

  it('ignores non-image file extensions', () => {
    const text = 'File at C:\\app\\data.json and C:\\app\\index.ts'
    expect(detectImagePaths(text)).toEqual([])
  })

  it('deduplicates paths', () => {
    const text = 'C:\\a\\img.png and again C:\\a\\img.png'
    expect(detectImagePaths(text)).toEqual(['C:\\a\\img.png'])
  })
})
