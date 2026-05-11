import type { Context, FilteredContext } from '@maxhub/max-bot-api'
import { processClientMessage } from '@/lib/bot/process-message'

/**
 * Входящее сообщение от клиента.
 * 5.3: вызываем processClientMessage. Бот отвечает либо шаблоном,
 * либо молчит (если ушло в inbox).
 */
export async function handleMessage(ctx: FilteredContext<Context, 'message_created'>): Promise<void> {
  const text = ctx.message?.body?.text ?? ''
  const chatId = ctx.chatId
  if (!chatId) {
    console.warn('[bot] message_created without chatId')
    return
  }
  const maxChatId = String(chatId)

  console.log(`[bot] incoming: chat=${maxChatId} text=${JSON.stringify(text).slice(0, 200)}`)

  try {
    const result = await processClientMessage({ maxChatId, text })
    console.log(`[bot] result: action=${result.action} reply=${result.reply ? 'YES' : 'NO'}${result.inboxItemId ? ` inbox=${result.inboxItemId}` : ''}`)
    if (result.reply) {
      await ctx.reply(result.reply)
    }
  } catch (err) {
    console.error('[bot] processClientMessage failed:', err)
  }
}

/**
 * Событие при первом старте бота клиентом (deep-link onboarding).
 * 5.6 переделаем под привязку maxChatId по deep-link токену.
 */
export async function handleBotStarted(ctx: FilteredContext<Context, 'bot_started'>): Promise<void> {
  const chatId = ctx.chatId
  const payload = ctx.startPayload
  console.log(`[MAX] bot_started chat=${chatId} payload=${payload ?? 'none'}`)
  await ctx.reply('Здравствуйте! Это бот компании «Будни». В будущем здесь будет ежедневный приём заказов.')
}
