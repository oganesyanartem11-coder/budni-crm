import type { Context, FilteredContext } from '@maxhub/max-bot-api'
import { prisma } from '@/lib/db/prisma'
import { processClientMessage } from '@/lib/bot/process-message'
import { logBotMessage } from '@/lib/bot/log-message'
import { getBotReplyTemplate } from '@/lib/bot/templates'
import { sendBotMessage } from '@/lib/max/send-message'

/**
 * Входящее сообщение от клиента.
 * 5.3+: вызываем processClientMessage. Бот отвечает либо шаблоном,
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

  // Back-fill maxUsername для клиентов, привязанных до 5.4a
  const senderUsername = ctx.message?.sender?.username ?? null
  if (senderUsername) {
    try {
      await prisma.client.updateMany({
        where: { maxChatId, maxUsername: null },
        data: { maxUsername: senderUsername },
      })
    } catch (err) {
      console.warn('[bot] back-fill maxUsername failed:', err)
    }
  }

  try {
    const result = await processClientMessage({ maxChatId, text })
    console.log(`[bot] result: action=${result.action} reply=${result.reply ? 'YES' : 'NO'}${result.inboxItemId ? ` inbox=${result.inboxItemId}` : ''}`)
    // NB: НЕ зовём ctx.reply(result.reply) — processClientMessage сам шлёт OUT
    // через sendBotMessage внутри handleBotResponse (с logBotMessage для треда).
    // Парный вызов давал дубль-сообщение в MAX (см. аудит 5.7c).
  } catch (err) {
    console.error('[bot] processClientMessage failed:', err)
  }
}

/**
 * bot_started — пользователь кликнул deep-link или впервые открыл диалог.
 * Если в payload есть онбординг-токен — ищем Client, затем User. Match → привязка.
 * Без токена или с невалидным токеном — даём подсказку.
 */
export async function handleBotStarted(ctx: FilteredContext<Context, 'bot_started'>): Promise<void> {
  const chatId = ctx.chatId
  const payload = ctx.startPayload?.trim() ?? ''
  console.log(`[bot] bot_started chat=${chatId} payload=${payload || 'none'}`)

  if (!chatId) return
  const chatIdStr = String(chatId)

  if (!payload) {
    await ctx.reply(
      'Здравствуйте! Чтобы начать пользоваться сервисом, попросите менеджера прислать вам персональную ссылку.'
    )
    return
  }

  // 1. Клиент
  const username = ctx.user?.username ?? null
  const client = await prisma.client.findUnique({ where: { maxOnboardingToken: payload } })
  if (client) {
    await prisma.client.update({
      where: { id: client.id },
      data: {
        maxChatId: chatIdStr,
        maxUsername: username,
        // onboardedAt отсутствует в модели Client — фиксируем только chat_id и username
      },
    })
    const greeting = getBotReplyTemplate('ONBOARDING')
    // sendBotMessage даёт естественную задержку 15-30 сек (см. send-message.ts).
    // Без этого приветствие приходит мгновенно после клика по deep-link.
    await sendBotMessage(chatIdStr, greeting)
    await logBotMessage({
      clientId: client.id,
      conversationId: null,
      direction: 'OUT',
      text: greeting,
    })
    return
  }

  // 2. Менеджер. 6.8a: User.maxChatId дропнут — пуши менеджерам идут через
  // Telegram. Onboarding-токен оставлен для backward compat, но реальной
  // привязки больше не делаем. Просто отмечаем onboardedAt и сообщаем,
  // что канал устарел.
  const user = await prisma.user.findUnique({ where: { maxOnboardingToken: payload } })
  if (user) {
    await prisma.user.update({
      where: { id: user.id },
      data: { onboardedAt: new Date() },
    })
    await ctx.reply(
      `Здравствуйте, ${user.name}! MAX-канал для менеджеров больше не используется — все уведомления приходят в Telegram. Привяжите Telegram в /settings.`
    )
    return
  }

  // 3. Не нашли никого — токен невалиден
  await ctx.reply('Ссылка не активна. Попросите менеджера сгенерировать новую.')
}
