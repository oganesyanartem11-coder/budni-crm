import type { Context } from 'grammy'
import { identifyTelegramUser } from './identify-user'
import { registerCallbackHandler } from './callback-router'
import { chatWithBoris } from '@/lib/boris/agent'
import { executePendingAction } from '@/lib/boris/executor'
import { TOOL_TITLES } from '@/lib/boris/preview'
import { shouldRespondInChat } from '@/lib/boris/group-filter'
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
  rateLimited: 'Погоди, частишь. Отдышимся минуту — и поехали дальше. ✋',
  error: 'Что-то пошло не так. Попробуй переформулировать.',
} as const

const BORIS_ALLOWED_ROLES = ['ADMIN', 'ADMIN_PRO', 'MANAGER'] as const

// Rate-limit: 20 успешных запросов в минуту на пользователя.
//
// Источник истины — таблица BorisMetrics: chatWithBoris() пишет туда ровно
// одну запись (source=ACTION_CHAT) на каждый прошедший этот guard запрос
// (см. src/lib/boris/agent.ts:166-187). Поэтому шарды Vercel видят общий
// счётчик, а отказы по rate-limit не самоусиливаются — в окно попадают
// только реально пропущенные вызовы.
const RATE_LIMIT_PER_MIN = 20

async function checkRateLimit(userId: string): Promise<boolean> {
  const oneMinuteAgo = new Date(Date.now() - 60_000)
  const count = await prisma.borisMetrics.count({
    where: {
      userId,
      source: 'ACTION_CHAT',
      createdAt: { gt: oneMinuteAgo },
    },
  })
  return count < RATE_LIMIT_PER_MIN
}

export async function handleBorisMessage(ctx: Context): Promise<void> {
  // 7.28: в группах отвечаем только на адресное «Борис»; в личке — всегда.
  if (!shouldRespondInChat(ctx)) return

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

  if (!(await checkRateLimit(user.id))) {
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
        const titleFor = (tool: string) => TOOL_TITLES[tool] ?? tool
        const summary = result.results
          .map((r) =>
            r.ok
              ? `✅ ${titleFor(r.tool)}`
              : `❌ ${titleFor(r.tool)}: ${r.error ?? 'ошибка'}`
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
