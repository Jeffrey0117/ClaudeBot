const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

const EXTENSIONS_PATTERN = IMAGE_EXTENSIONS.join('|')

// Match absolute paths: C:\...\file.png or /home/.../file.png
const PATH_REGEX = new RegExp(
  `(?:[A-Za-z]:\\\\[^\\s"'<>|*?]+|/[^\\s"'<>|*?]+)\\.(?:${EXTENSIONS_PATTERN})`,
  'gi'
)

export function detectImagePaths(text: string): readonly string[] {
  const matches = text.match(PATH_REGEX)
  if (!matches) return []
  return [...new Set(matches)]
}
