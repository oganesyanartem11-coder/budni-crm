import type { Context, FilteredContext } from '@maxhub/max-bot-api'
import { prisma } from '@/lib/db/prisma'
import { processClientMessage } from '@/lib/bot/process-message'
import { logBotMessage } from '@/lib/bot/log-message'
import { pickWelcomeKind, getWelcomeText } from '@/lib/bot/welcome'
import { sendBotMessage } from '@/lib/max/send-message'
import { findClientByMaxChatId } from '@/lib/db/queries/bot'
import { withDbRetry } from '@/lib/db-retry'
import { createInboxItem } from '@/lib/bot/create-inbox-item'
import {
  handleWeeklyPhotoSubmission,
  handleWeeklyTextSubmission,
} from '@/lib/max/handlers/weekly'

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

  // MEGA wiring (Subagent C): WEEKLY-клиент прислал заявку (фото бумажного
  // списка или SMS-текст). Резолвим клиента и, если он WEEKLY, обрабатываем
  // через выделенный пайплайн (parser → sanity → actions → notify) и
  // ОБЯЗАТЕЛЬНО early-return — WEEKLY-сообщения НЕ должны попадать в
  // processClientMessage (иначе двойная обработка). Не-WEEKLY клиенты (и
  // случаи, когда клиент не найден) идут по старому пути без изменений.
  // P1001-фикс: первый запрос холодного Neon падает с P1001. Ретраим этот
  // (первый) read, чтобы прогреть compute — дальше по handler'у БД уже тёплая.
  const client = await withDbRetry(() => findClientByMaxChatId(maxChatId), {
    label: 'max-webhook',
  })
  const isWeekly =
    !!client &&
    client.isActive &&
    client.locations.some((l) =>
      l.mealConfigs.some((c) => c.orderType === 'WEEKLY' && c.isActive)
    )

  if (isWeekly && client) {
    // Любой исход WEEKLY-ветки — early-return: эти сообщения НИКОГДА не уходят
    // в processClientMessage (иначе двойная обработка). Ошибки внутри глотаем,
    // не пробрасывая в общий поток.
    try {
      const attachments = ctx.message?.body?.attachments ?? []
      const imageAttachment = attachments.find(
        (a): a is typeof a & { payload?: { url?: string } } => a?.type === 'image'
      )
      const nonImageAttachment = attachments.find((a) => a?.type !== 'image')

      // #6: раньше WEEKLY-ветка делала early-return МИМО processClientMessage,
      // где обычно пишется logBotMessage(IN) — поэтому заявка клиента не попадала
      // в тред /inbox (виден был только welcome OUT). Логируем входящее здесь.
      // Пустой text (фото без подписи) → плейсхолдер, иначе IN-запись была бы пустой.
      const inboundText = text.trim()
        ? text
        : imageAttachment
          ? '[фото заявки]'
          : nonImageAttachment
            ? `[вложение: ${nonImageAttachment.type}]`
            : ''
      if (inboundText) {
        await logBotMessage({
          clientId: client.id,
          conversationId: null,
          direction: 'IN',
          text: inboundText,
        })
      }

      // Не-image вложение (документ/файл) — парсер не умеет. В inbox менеджеру.
      if (nonImageAttachment && !imageAttachment) {
        await createInboxItem({
          clientId: client.id,
          reason: 'NON_NUMERIC',
          humanReason: `WEEKLY-клиент прислал не-image вложение (${nonImageAttachment.type}) — обработать вручную`,
          priority: 'NORMAL',
          clientMessage: text || null,
        })
        await sendBotMessage(maxChatId, 'Получили файл, обрабатываем…')
        return
      }

      // Фото заявки.
      const attachmentUrl = imageAttachment?.payload?.url
      if (attachmentUrl) {
        await handleWeeklyPhotoSubmission({
          client,
          attachmentUrl,
          caption: text || undefined,
          chatId: maxChatId,
        })
        return
      }

      // Текст-заявка (SMS-style список).
      if (text.trim()) {
        await handleWeeklyTextSubmission({ client, text, chatId: maxChatId })
        return
      }

      // Пусто (ни фото, ни текста) — нечего обрабатывать.
      return
    } catch (err) {
      console.error('[bot] WEEKLY submission handling failed:', err)
      return
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
  const client = await prisma.client.findUnique({
    where: { maxOnboardingToken: payload },
    // Welcome ветвится по типу клиента (см. welcome.ts) — подгружаем минимум:
    // orderType конфигов и sameDayDelivery локаций.
    include: {
      mealConfigs: { select: { orderType: true } },
      locations: { select: { sameDayDelivery: true } },
    },
  })
  if (client) {
    await prisma.client.update({
      where: { id: client.id },
      data: {
        maxChatId: chatIdStr,
        maxUsername: username,
        // onboardedAt отсутствует в модели Client — фиксируем только chat_id и username
      },
    })
    const kind = pickWelcomeKind(client)
    console.log(`[max-welcome] client=${client.id} kind=${kind}`)
    const greeting = getWelcomeText(kind)
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
