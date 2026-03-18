/**
 * /license — Admin-only license key management for Electron desktop clients.
 *
 * Subcommands:
 *   /license create <plan> [label]  — generate a new license key
 *   /license list                   — list all licenses
 *   /license revoke <key>           — revoke a license
 *   /license renew <key> [days]     — renew (default 30 days)
 *   /license info <key>             — show license details
 */

import type { BotContext } from '../../types/context.js'
import { env } from '../../config/env.js'
import {
  createLicense,
  listLicenses,
  revokeLicense,
  renewLicense,
  getLicense,
  PLAN_LIMITS,
  type LicensePlan,
} from '../../remote/license-store.js'

const VALID_PLANS = new Set<string>(['basic', 'plus', 'pro'])

function isAdmin(ctx: BotContext): boolean {
  const chatId = ctx.chat?.id
  return chatId !== undefined && chatId === env.ADMIN_CHAT_ID
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export async function licenseCommand(ctx: BotContext): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('🚫 此指令僅限管理員使用')
    return
  }

  const text = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') ?? ''
  const parts = text.replace(/^\/license\s*/, '').trim().split(/\s+/)
  const sub = parts[0]?.toLowerCase() ?? ''

  if (sub === 'create') {
    await handleCreate(ctx, parts.slice(1))
  } else if (sub === 'list') {
    await handleList(ctx)
  } else if (sub === 'revoke') {
    await handleRevoke(ctx, parts[1])
  } else if (sub === 'renew') {
    await handleRenew(ctx, parts[1], parts[2])
  } else if (sub === 'info') {
    await handleInfo(ctx, parts[1])
  } else {
    await ctx.reply(
      '📋 *License 管理*\n\n'
      + '`/license create <plan> [label]`\n'
      + '`/license list`\n'
      + '`/license revoke <key>`\n'
      + '`/license renew <key> [days]`\n'
      + '`/license info <key>`\n\n'
      + '方案: basic / plus / pro',
      { parse_mode: 'Markdown' },
    )
  }
}

async function handleCreate(ctx: BotContext, args: string[]): Promise<void> {
  const plan = args[0]?.toLowerCase()
  if (!plan || !VALID_PLANS.has(plan)) {
    await ctx.reply('用法: `/license create <basic|plus|pro> [label]`', { parse_mode: 'Markdown' })
    return
  }
  const label = args.slice(1).join(' ') || '未命名'
  const license = createLicense(plan as LicensePlan, label)
  const limits = PLAN_LIMITS[license.plan]

  await ctx.reply(
    '✅ *序號已建立*\n\n'
    + `🔑 \`${license.key}\`\n`
    + `📦 方案: ${license.plan}\n`
    + `🏷️ 備註: ${label}\n`
    + `📅 到期: ${formatDate(license.expiresAt)}\n`
    + `⚡ 額度: ${limits.rateBudget}/5min, ${limits.weeklyBudget}/週`,
    { parse_mode: 'Markdown' },
  )
}

async function handleList(ctx: BotContext): Promise<void> {
  const licenses = listLicenses()
  if (licenses.length === 0) {
    await ctx.reply('目前沒有序號')
    return
  }

  const now = Date.now()
  const lines = licenses.map((l) => {
    const status = l.revoked ? '🚫' : now > l.expiresAt ? '⏰' : '✅'
    const weeklyUsed = l.weeklyUsage.reduce((s, r) => s + r.turns, 0)
    const limits = PLAN_LIMITS[l.plan]
    return `${status} \`${l.key}\` ${l.plan} ${l.label} (${weeklyUsed}/${limits.weeklyBudget}) ${formatDate(l.expiresAt)}`
  })

  await ctx.reply('📋 *序號列表*\n\n' + lines.join('\n'), { parse_mode: 'Markdown' })
}

async function handleRevoke(ctx: BotContext, key: string | undefined): Promise<void> {
  if (!key) {
    await ctx.reply('用法: `/license revoke <key>`', { parse_mode: 'Markdown' })
    return
  }
  const ok = revokeLicense(key.toUpperCase())
  await ctx.reply(ok ? `🚫 已停用: \`${key.toUpperCase()}\`` : '❌ 序號不存在', { parse_mode: 'Markdown' })
}

async function handleRenew(ctx: BotContext, key: string | undefined, daysStr: string | undefined): Promise<void> {
  if (!key) {
    await ctx.reply('用法: `/license renew <key> [days]`', { parse_mode: 'Markdown' })
    return
  }
  const days = daysStr ? parseInt(daysStr, 10) : 30
  if (isNaN(days) || days < 1) {
    await ctx.reply('天數必須是正整數')
    return
  }
  const ok = renewLicense(key.toUpperCase(), days)
  if (ok) {
    const license = getLicense(key.toUpperCase())
    await ctx.reply(
      `✅ 已續期 ${days} 天\n到期日: ${license ? formatDate(license.expiresAt) : '?'}`,
      { parse_mode: 'Markdown' },
    )
  } else {
    await ctx.reply('❌ 序號不存在')
  }
}

async function handleInfo(ctx: BotContext, key: string | undefined): Promise<void> {
  if (!key) {
    await ctx.reply('用法: `/license info <key>`', { parse_mode: 'Markdown' })
    return
  }
  const license = getLicense(key.toUpperCase())
  if (!license) {
    await ctx.reply('❌ 序號不存在')
    return
  }

  const now = Date.now()
  const limits = PLAN_LIMITS[license.plan]
  const rateUsed = license.rateUsage.filter((r) => r.timestamp > now - 5 * 60_000).reduce((s, r) => s + r.turns, 0)
  const weeklyUsed = license.weeklyUsage.filter((r) => r.timestamp > now - 7 * 24 * 60 * 60_000).reduce((s, r) => s + r.turns, 0)
  const status = license.revoked ? '🚫 已停用' : now > license.expiresAt ? '⏰ 已過期' : '✅ 有效'

  await ctx.reply(
    `🔑 *${license.key}*\n\n`
    + `狀態: ${status}\n`
    + `方案: ${license.plan}\n`
    + `備註: ${license.label}\n`
    + `建立: ${formatDate(license.createdAt)}\n`
    + `到期: ${formatDate(license.expiresAt)}\n`
    + `短期: ${rateUsed}/${limits.rateBudget} (5min)\n`
    + `週額: ${weeklyUsed}/${limits.weeklyBudget}\n`
    + `待結: ${license.pendingReserve}`,
    { parse_mode: 'Markdown' },
  )
}
