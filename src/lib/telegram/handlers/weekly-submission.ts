import { prisma } from '@/lib/db/prisma'
import { cancelWeeklySubmission } from '@/lib/weekly/actions'
import { registerCallbackHandler } from '../callback-router'
import { notifyAllAdminProDirect, escapeHtml } from '../notify'
import { weeklySubmissionCancelButton } from '../buttons'

/**
 * MEGA weekly-order: TG-обработка недельных заявок.
 *
 *  1. notifyManagerAboutWeeklySubmission — пуш всем ADMIN_PRO о принятой
 *     (AUTO_CONFIRMED, с кнопкой «Отменить заявку») либо требующей ручной
 *     проверки (NEEDS_REVIEW, без кнопки) заявке.
 *  2. callback-handler scope 'wsub' — обработка нажатия «Отменить заявку»:
 *     откат CONFIRMED-заказов в DRAFT через cancelWeeklySubmission.
 *
 * Callback регистрируется ПРИ ИМПОРТЕ модуля (side-effect), как у scope
 * 'boris'. Чтобы регистрация реально произошла, модуль импортируется
 * за side-effect в bot.ts (`import '@/lib/telegram/handlers/weekly-submission'`).
 */

const RU_WEEKDAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const

/**
 * `YYYY-MM-DD` → `DD.MM (Пн)`. Компоненты парсим руками и строим UTC-дату,
 * чтобы РУ-день недели не плыл от tz сервера (тот же приём, что в actions.ts).
 */
function formatItemDate(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) {
    // Неожиданный формат — отдаём как есть, без дня недели.
    return dateStr
  }
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const weekdayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const weekday = RU_WEEKDAYS_SHORT[weekdayIndex]
  return `${m[3]}.${m[2]} (${weekday})`
}

export interface WeeklyNotificationParams {
  submissionId: string
  status: 'AUTO_CONFIRMED' | 'NEEDS_REVIEW'
  clientName: string
  items: { date: string; portions: number }[]
  dietaryNotes: string | null
  confidence: number
  reason: string
  source: 'PHOTO' | 'TEXT'
  blobUrl?: string
  rawText?: string
}

/**
 * Чистый форматтер текста пуша — без вызовов Bot API, чтобы покрыть тестом.
 * Динамические подстановки (имя клиента, пометки, rawText) экранируем под
 * HTML parseMode (notifyAllAdminProDirect шлёт с parseMode='HTML' по дефолту).
 * Литеральный текст шаблонов НЕ меняем.
 */
export function formatWeeklyNotification(params: WeeklyNotificationParams): string {
  const {
    status,
    clientName,
    items,
    dietaryNotes,
    confidence,
    reason,
    source,
    blobUrl,
    rawText,
  } = params

  const clientNameSafe = escapeHtml(clientName)

  if (status === 'AUTO_CONFIRMED') {
    const itemLines = items
      .map((i) => `${formatItemDate(i.date)} — ${i.portions} порций`)
      .join('\n')
    const notesSafe = dietaryNotes ? escapeHtml(dietaryNotes) : 'нет'
    const confidenceStr = confidence.toFixed(2)
    return (
      `✅ ${clientNameSafe}: заявка на след неделю принята.\n` +
      `\n` +
      `${itemLines}\n` +
      `\n` +
      `Пометки: ${notesSafe}\n` +
      `Источник: ${source}, confidence ${confidenceStr}\n` +
      `\n` +
      `Если что-то не так — нажми кнопку.`
    )
  }

  // NEEDS_REVIEW
  const draftLines = items.map((i) => `${formatItemDate(i.date)} — ${i.portions} (?)`).join('\n')
  const sourceLine =
    source === 'PHOTO' ? `PHOTO ${blobUrl ?? ''}` : `TEXT: ${escapeHtml(rawText ?? '')}`
  return (
    `🔍 ${clientNameSafe}: заявка получена, требует ручной проверки.\n` +
    `\n` +
    `Причина: ${escapeHtml(reason)}\n` +
    `\n` +
    `Распарсено (черновик):\n` +
    `${draftLines}\n` +
    `\n` +
    `Источник: ${sourceLine}\n` +
    `Создай заказы вручную через /orders/new если нужно.`
  )
}

/**
 * Пуш всем ADMIN_PRO о новой недельной заявке. После успешной отправки
 * проставляет managerNotifiedAt на WeeklyOrderSubmission.
 */
export async function notifyManagerAboutWeeklySubmission(
  params: WeeklyNotificationParams
): Promise<void> {
  const text = formatWeeklyNotification(params)

  if (params.status === 'AUTO_CONFIRMED') {
    await notifyAllAdminProDirect(text, {
      replyMarkup: weeklySubmissionCancelButton(params.submissionId),
    })
  } else {
    await notifyAllAdminProDirect(text)
  }

  await prisma.weeklyOrderSubmission.update({
    where: { id: params.submissionId },
    data: { managerNotifiedAt: new Date() },
  })
}

// Регистрация callback-handler'а ПРИ ИМПОРТЕ модуля (side-effect).
// Импортируется один раз за side-effect в bot.ts — двойной регистрации нет.
registerCallbackHandler({
  scope: 'wsub',
  async handle(ctx, action, submissionId) {
    if (action !== 'cancel') {
      await ctx.answerCallbackQuery({ text: 'Неизвестное действие' })
      return
    }

    // Маппинг telegram id → User: telegramChatId хранится строкой,
    // ставится при онбординге (см. identify-user.ts / bot.ts /start).
    const telegramId = ctx.from?.id
    const user = telegramId
      ? await prisma.user.findFirst({
          where: {
            telegramChatId: String(telegramId),
            role: 'ADMIN_PRO',
            isActive: true,
          },
          select: { id: true },
        })
      : null

    if (!user) {
      await ctx.answerCallbackQuery({ text: 'Только для ADMIN_PRO', show_alert: true })
      return
    }

    const { cancelled, notCancelled } = await cancelWeeklySubmission({
      submissionId,
      cancelledById: user.id,
    })

    const text =
      '❌ Заявка отменена. Откатили ' +
      cancelled +
      ' заказов в DRAFT.' +
      (notCancelled.length
        ? '\n⚠️ Уже в производстве и не тронуты: ' +
          notCancelled.map((o) => o.orderId).join(', ') +
          ' — свяжись с шефом.'
        : '')

    try {
      await ctx.editMessageText(text)
    } catch (err) {
      // Сообщение могло стать нередактируемым (старое / уже изменено) — не падаем.
      console.error('[weekly-submission] editMessageText failed', err)
    }

    await ctx.answerCallbackQuery({ text: 'Готово' })
  },
})
