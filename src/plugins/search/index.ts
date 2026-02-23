import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'

interface SearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

async function searchDuckDuckGo(query: string): Promise<readonly SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  })

  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`)
  }

  const html = await response.text()
  const results: SearchResult[] = []

  // Parse DuckDuckGo HTML results — split on result__body (partial class match)
  const resultBlocks = html.split('result__body')
  for (const block of resultBlocks.slice(1, 6)) {
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/)
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)

    if (titleMatch) {
      const rawUrl = titleMatch[1]
      // DuckDuckGo wraps URLs in redirect — extract actual URL
      const uddgMatch = rawUrl.match(/uddg=([^&]+)/)
      const actualUrl = uddgMatch
        ? decodeURIComponent(uddgMatch[1])
        : rawUrl.replace(/^\/\//, 'https://')
      const title = titleMatch[2].replace(/<[^>]*>/g, '').trim()
      const snippet = snippetMatch
        ? snippetMatch[1]
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#x27;/g, "'")
            .trim()
        : ''

      if (title && actualUrl.startsWith('http')) {
        results.push({ title, url: actualUrl, snippet })
      }
    }
  }

  return results
}

async function searchCommand(ctx: BotContext): Promise<void> {
  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const query = text.replace(/^\/search\s*/i, '').trim()

  if (!query) {
    await ctx.reply('用法: `/search 搜尋內容`', { parse_mode: 'Markdown' })
    return
  }

  try {
    const results = await searchDuckDuckGo(query)

    if (results.length === 0) {
      await ctx.reply(`🔍 「${query}」 沒有找到結果`)
      return
    }

    const lines: string[] = []
    for (const [i, r] of results.entries()) {
      const snippet = r.snippet.slice(0, 150)
      lines.push(`${i + 1}. ${r.title}`)
      if (snippet) lines.push(`   ${snippet}${r.snippet.length > 150 ? '...' : ''}`)
      lines.push(`   ${r.url}`)
      lines.push('')
    }

    await ctx.reply(`🔍 ${query}\n\n${lines.join('\n')}`, {
      link_preview_options: { is_disabled: true },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await ctx.reply(`❌ 搜尋失敗: ${msg}`)
  }
}

const searchPlugin: Plugin = {
  name: 'search',
  description: '網頁搜尋（DuckDuckGo）',
  commands: [
    {
      name: 'search',
      description: '搜尋網頁',
      handler: searchCommand,
    },
  ],
}

export default searchPlugin
