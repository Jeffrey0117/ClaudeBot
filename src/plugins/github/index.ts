import { Markup } from 'telegraf'
import type { Plugin } from '../../types/plugin.js'
import type { BotContext } from '../../types/context.js'
import { env } from '../../config/env.js'

const CALLBACK_PREFIX = 'ghstar:'
const VALID_NAME = /^[a-zA-Z0-9._-]+$/
const GITHUB_URL_RE = /^https?:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/?/

function isValidOwnerRepo(owner: string, repo: string): boolean {
  return VALID_NAME.test(owner) && VALID_NAME.test(repo)
}

function formatStars(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}

async function ghFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  })
}

async function starRepo(owner: string, repo: string): Promise<{ success: boolean; stars: number; description: string }> {
  const starRes = await ghFetch(`/user/starred/${owner}/${repo}`, { method: 'PUT' })
  if (starRes.status !== 204) {
    return { success: false, stars: 0, description: '' }
  }

  const infoRes = await ghFetch(`/repos/${owner}/${repo}`)
  if (!infoRes.ok) {
    return { success: true, stars: 0, description: '' }
  }

  const info = await infoRes.json() as { stargazers_count: number; description: string | null }
  return { success: true, stars: info.stargazers_count, description: info.description ?? '' }
}

interface SearchItem {
  readonly full_name: string
  readonly stargazers_count: number
  readonly description: string | null
}

async function searchRepos(keyword: string): Promise<readonly SearchItem[]> {
  const res = await ghFetch(`/search/repositories?q=${encodeURIComponent(keyword)}&sort=stars&per_page=5`)
  if (!res.ok) return []
  const data = await res.json() as { items: SearchItem[] }
  return data.items ?? []
}

async function starCommand(ctx: BotContext): Promise<void> {
  const raw = (ctx.message && 'text' in ctx.message) ? ctx.message.text : ''
  const input = raw.replace(/^\/star(@\S+)?\s*/, '').trim()

  if (!input) {
    await ctx.reply('Usage:\n`/star owner/repo`\n`/star https://github.com/owner/repo`\n`/star keyword`', { parse_mode: 'Markdown' })
    return
  }

  if (!env.GITHUB_TOKEN) {
    await ctx.reply('❌ GitHub token not configured\nSet `GITHUB_TOKEN` in `.env` with `public_repo` scope.', { parse_mode: 'Markdown' })
    return
  }

  // GitHub URL → extract owner/repo
  const urlMatch = input.match(GITHUB_URL_RE)
  if (urlMatch) {
    const [, owner, repo] = urlMatch
    try {
      const result = await starRepo(owner, repo)
      if (!result.success) {
        await ctx.reply(`❌ Failed to star \`${owner}/${repo}\` — repo not found or token lacks permission.`, { parse_mode: 'Markdown' })
        return
      }
      const desc = result.description ? `\n_${result.description}_` : ''
      await ctx.reply(`⭐ Starred **${owner}/${repo}** (★ ${formatStars(result.stars)})${desc}`, { parse_mode: 'Markdown' })
    } catch (err) {
      await ctx.reply(`❌ Network error: ${err instanceof Error ? err.message : 'unknown'}`)
    }
    return
  }

  // owner/repo → direct star
  if (input.includes('/')) {
    const [owner, repo] = input.split('/', 2)
    if (!owner || !repo || !isValidOwnerRepo(owner, repo)) {
      await ctx.reply('❌ Invalid format. Use `owner/repo`.', { parse_mode: 'Markdown' })
      return
    }

    try {
      const result = await starRepo(owner, repo)
      if (!result.success) {
        await ctx.reply(`❌ Failed to star \`${owner}/${repo}\` — repo not found or token lacks permission.`, { parse_mode: 'Markdown' })
        return
      }
      const desc = result.description ? `\n_${result.description}_` : ''
      await ctx.reply(`⭐ Starred **${owner}/${repo}** (★ ${formatStars(result.stars)})${desc}`, { parse_mode: 'Markdown' })
    } catch (err) {
      await ctx.reply(`❌ Network error: ${err instanceof Error ? err.message : 'unknown'}`)
    }
    return
  }

  // keyword → search
  try {
    const items = await searchRepos(input)
    if (items.length === 0) {
      await ctx.reply(`❌ No repos found for \`${input}\``, { parse_mode: 'Markdown' })
      return
    }

    const buttons = items.map((item) =>
      [Markup.button.callback(`${item.full_name} ★${formatStars(item.stargazers_count)}`, `${CALLBACK_PREFIX}${item.full_name}`)]
    )
    await ctx.reply(`🔍 Results for **${input}**:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    })
  } catch (err) {
    await ctx.reply(`❌ Search error: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}

async function handleCallback(ctx: BotContext, data: string): Promise<boolean> {
  if (!data.startsWith(CALLBACK_PREFIX)) return false

  const fullName = data.slice(CALLBACK_PREFIX.length)
  const [owner, repo] = fullName.split('/', 2)
  if (!owner || !repo || !isValidOwnerRepo(owner, repo)) {
    await ctx.answerCbQuery('Invalid repo')
    return true
  }

  await ctx.answerCbQuery('⭐ Starring...')

  try {
    const result = await starRepo(owner, repo)
    if (!result.success) {
      await ctx.editMessageText(`❌ Failed to star \`${fullName}\``, { parse_mode: 'Markdown' }).catch(() => {})
      return true
    }
    const desc = result.description ? `\n_${result.description}_` : ''
    await ctx.editMessageText(`⭐ Starred **${fullName}** (★ ${formatStars(result.stars)})${desc}`, { parse_mode: 'Markdown' }).catch(() => {})
  } catch (err) {
    await ctx.editMessageText(`❌ Error starring repo. Please try again.`).catch(() => {})
  }

  return true
}

const githubPlugin: Plugin = {
  name: 'github',
  description: 'GitHub Star — 快速 star repo',
  commands: [
    {
      name: 'star',
      description: 'Star a GitHub repo (owner/repo or search keyword)',
      handler: starCommand,
    },
  ],
  onCallback: handleCallback,
}

export default githubPlugin
