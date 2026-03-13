import type { BotContext } from '../../types/context.js'
import { getUserState, setUserAI } from '../state.js'
import { buildModelKeyboard } from '../../telegram/keyboard-builder.js'
import { formatAILabel } from '../../ai/types.js'
import type { AIModelSelection, AIBackend } from '../../ai/types.js'
import { pinProjectStatus } from '../bio-updater.js'

const VALID_BACKENDS = new Set<string>(['claude', 'gemini', 'codex', 'auto'])

const BACKEND_MODELS: Record<string, readonly string[]> = {
  claude: ['haiku', 'sonnet', 'opus'],
  gemini: ['flash-lite', 'flash', 'pro'],
  codex: ['codex'],
}

export async function modelCommand(ctx: BotContext): Promise<void> {
  const chatId = ctx.chat?.id
  if (!chatId) return

  const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text ?? '' : ''
  const args = text.replace(/^\/model\s*/, '').trim().toLowerCase()

  const threadId = ctx.message?.message_thread_id
  const state = getUserState(chatId, threadId)

  // No args → show keyboard
  if (!args) {
    const keyboard = buildModelKeyboard(state.ai)
    await ctx.reply(`\u{1F916} \u{76EE}\u{524D}: \`${formatAILabel(state.ai)}\`\n\u{9078}\u{64C7} AI \u{5F8C}\u{7AEF}\u{8207}\u{6A21}\u{578B}:`, {
      ...keyboard,
      parse_mode: 'Markdown',
    })
    return
  }

  const updatePin = async (ai: AIModelSelection) => {
    if (state.selectedProject) {
      await pinProjectStatus(chatId, state.selectedProject, formatAILabel(ai))
    }
  }

  // /model auto
  if (args === 'auto') {
    const ai: AIModelSelection = { backend: 'auto', model: 'auto' }
    setUserAI(chatId, ai, threadId)
    await ctx.reply(`\u{2705} \u{5DF2}\u{5207}\u{63DB}\u{70BA} *auto* \u{6A21}\u{5F0F}\n\u{6839}\u{64DA}\u{63D0}\u{793A}\u{5167}\u{5BB9}\u{81EA}\u{52D5}\u{9078}\u{64C7}\u{6700}\u{4F73}\u{5F8C}\u{7AEF}`, { parse_mode: 'Markdown' })
    await updatePin(ai)
    return
  }

  // /model <backend> <model>  OR  /model <model>
  const parts = args.split(/\s+/)

  if (parts.length === 1) {
    // Could be a model name → find which backend it belongs to
    const modelName = parts[0]
    for (const [backend, models] of Object.entries(BACKEND_MODELS)) {
      if (models.includes(modelName)) {
        const ai: AIModelSelection = { backend: backend as AIBackend, model: modelName }
        setUserAI(chatId, ai, threadId)
        await ctx.reply(`\u{2705} \u{5DF2}\u{5207}\u{63DB}\u{70BA} \`${formatAILabel(ai)}\``, { parse_mode: 'Markdown' })
        await updatePin(ai)
        return
      }
    }
    await ctx.reply(`\u{274C} \u{627E}\u{4E0D}\u{5230}\u{6A21}\u{578B} "${modelName}"\n\u{7528}\u{6CD5}: \`/model [backend] [model]\`\n\u{7BC4}\u{4F8B}: \`/model gemini flash\``, { parse_mode: 'Markdown' })
    return
  }

  // Two parts: /model <backend> <model>
  const [backendStr, modelStr] = parts

  if (!VALID_BACKENDS.has(backendStr)) {
    await ctx.reply(`\u{274C} \u{7121}\u{6548}\u{5F8C}\u{7AEF} "${backendStr}"\n\u{53EF}\u{7528}: claude, gemini, codex, auto`)
    return
  }

  if (backendStr === 'auto') {
    const ai: AIModelSelection = { backend: 'auto', model: 'auto' }
    setUserAI(chatId, ai, threadId)
    await ctx.reply(`\u{2705} \u{5DF2}\u{5207}\u{63DB}\u{70BA} *auto*`, { parse_mode: 'Markdown' })
    await updatePin(ai)
    return
  }

  const validModels = BACKEND_MODELS[backendStr]
  if (validModels && !validModels.includes(modelStr)) {
    await ctx.reply(`\u{274C} ${backendStr} \u{7121}\u{6548}\u{6A21}\u{578B} "${modelStr}"\n\u{53EF}\u{7528}: ${validModels.join(', ')}`)
    return
  }

  const ai: AIModelSelection = { backend: backendStr as AIBackend, model: modelStr }
  setUserAI(chatId, ai, threadId)
  await ctx.reply(`\u{2705} \u{5DF2}\u{5207}\u{63DB}\u{70BA} \`${formatAILabel(ai)}\``, { parse_mode: 'Markdown' })
  await updatePin(ai)
}
