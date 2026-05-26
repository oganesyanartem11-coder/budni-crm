import type { Context } from 'grammy'
import { identifyTelegramUser } from './identify-user'
import { registerCallbackHandler } from './callback-router'
import { chatWithBoris } from '@/lib/boris/agent'
import { executePendingAction } from '@/lib/boris/executor'
import { prisma } from '@/lib/db/prisma'

/**
 * Sprint 7.16.A.2 (блок B3): TG-обработчик "Action-Бориса".
 *
 * Заменяет старый handleOtherMessage из bot.ts: теперь любое нон-командное
 * сообщение от идентифицированного менеджера уходит в LLM-агента Бориса.
 *
 * Идентификация ручная (identifyTelegramUser, НЕ requireTelegramUser),
 * потому что нужны три разные ветки ответа:
 *  - не нашёл в БД  → notIdentified
 *  - роль не та     → wrongRole (вежливо, для поваров/курьеров)
 *  - всё ок         → chatWithBoris
 *
 * Callback-кнопки ✅ Подтвердить / ✗ Отмена регистрируются через
 * registerCallbackHandler({ scope: 'boris' }) при импорте модуля.
 */

const TEMPLATE_REPLIES = {
  notIdentified: 'Не нашёл тебя в системе. Обратись к админу за подключением.',
  wrongRole:
    'Привет, я Борис, помощник менеджеров. Тебе пока не нужен — если что-то нужно по работе, обратись к менеджеру напрямую.',
  rateLimited: 'Слишком много запросов. Подожди минуту.',
  error: 'Что-то пошло не так. Попробуй переформулировать.',
} as const

const BORIS_ALLOWED_ROLES = ['ADMIN', 'ADMIN_PRO', 'MANAGER'] as const

// In-memory rate limit (per-process — для MVP, не shared между Vercel instances).
// На horizontal scale нужно вынести в Redis / БД, иначе лимит "20/мин" умножается
// на количество инстансов. Для MVP-нагрузки приемлемо.
const rateLimits = new Map<string, number[]>()
const RATE_LIMIT_PER_MIN = 20

function checkRateLimit(userId: string): boolean {
  const now = Date.now()
  const arr = rateLimits.get(userId) ?? []
  const recent = arr.filter((t) => now - t < 60_000)
  if (recent.length >= RATE_LIMIT_PER_MIN) {
    rateLimits.set(userId, recent)
    return false
  }
  recent.push(now)
  rateLimits.set(userId, recent)
  return true
}

export async function handleBorisMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? ''
  if (!text || text.startsWith('/')) return // /команды не наш case

  const user = await identifyTelegramUser(ctx)
  if (!user) {
    await ctx.reply(TEMPLATE_REPLIES.notIdentified)
    return
  }
  if (
    !BORIS_ALLOWED_ROLES.includes(
      user.role as typeof BORIS_ALLOWED_ROLES[number]
    )
  ) {
    await ctx.reply(TEMPLATE_REPLIES.wrongRole)
    return
  }

  if (!checkRateLimit(user.id)) {
    await ctx.reply(TEMPLATE_REPLIES.rateLimited)
    return
  }

  // Найти открытую conversation (последняя где closedAt = null).
  const conv = await prisma.borisConversation.findFirst({
    where: { userId: user.id, closedAt: null },
    orderBy: { lastMessageAt: 'desc' },
  })

  try {
    // "typing..." в TG — не критично если упадёт, не блокируем основной поток.
    await ctx.replyWithChatAction('typing').catch(() => {
      /* не критично */
    })

    const result = await chatWithBoris({
      userId: user.id,
      conversationId: conv?.id,
      userText: text,
    })

    if (result.pendingActionId && result.preview) {
      await ctx.reply(result.preview, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Подтвердить',
                callback_data: `boris:confirm:${result.pendingActionId}`,
              },
              {
                text: '✗ Отмена',
                callback_data: `boris:cancel:${result.pendingActionId}`,
              },
            ],
          ],
        },
        parse_mode: 'HTML',
      })
    } else {
      await ctx.reply(result.reply, { parse_mode: 'HTML' })
    }
  } catch (e) {
    console.error('[boris-handler]', e)
    await ctx.reply(TEMPLATE_REPLIES.error)
  }
}

// Регистрация callback-handler'а ПРИ ИМПОРТЕ модуля (side-effect).
// OK, потому что boris-handler импортируется один раз в bot.ts при
// инициализации singleton'а — двойной регистрации не будет.
registerCallbackHandler({
  scope: 'boris',
  async handle(ctx, action, id) {
    const user = await identifyTelegramUser(ctx)
    if (!user) {
      await ctx.answerCallbackQuery({
        text: 'Не нашёл тебя',
        show_alert: true,
      })
      return
    }
    if (
      !BORIS_ALLOWED_ROLES.includes(
        user.role as typeof BORIS_ALLOWED_ROLES[number]
      )
    ) {
      await ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true })
      return
    }

    const pending = await prisma.borisPendingAction.findUnique({
      where: { id },
      include: { conversation: true },
    })
    if (!pending || pending.conversation.userId !== user.id) {
      await ctx.answerCallbackQuery({
        text: 'Действие не найдено',
        show_alert: true,
      })
      return
    }
    if (pending.executedAt || pending.cancelledAt) {
      await ctx.answerCallbackQuery({
        text: 'Уже обработано',
        show_alert: true,
      })
      return
    }
    if (pending.expiresAt < new Date()) {
      await ctx.answerCallbackQuery({
        text: 'Время вышло (5 мин)',
        show_alert: true,
      })
      return
    }

    if (action === 'confirm') {
      try {
        const result = await executePendingAction(id, user.id)
        const summary = result.results
          .map((r) =>
            r.ok ? `✅ ${r.tool}` : `❌ ${r.tool}: ${r.error ?? 'ошибка'}`
          )
          .join('\n')
        await ctx.editMessageText(`${pending.previewText}\n\n${summary}`, {
          parse_mode: 'HTML',
        })
      } catch (e) {
        console.error('[boris-handler] confirm error', e)
        await ctx.answerCallbackQuery({
          text: 'Ошибка выполнения',
          show_alert: true,
        })
      }
    } else if (action === 'cancel') {
      await prisma.borisPendingAction.update({
        where: { id },
        data: { cancelledAt: new Date() },
      })
      await ctx.editMessageText(`${pending.previewText}\n\n✗ Отменено`, {
        parse_mode: 'HTML',
      })
    } else {
      await ctx.answerCallbackQuery({
        text: 'Неизвестное действие',
        show_alert: true,
      })
      return
    }
  },
})
