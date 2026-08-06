import type { Context } from 'grammy'
import type { MealType } from '@prisma/client'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import {
  confirmPendingAnomaly,
  rejectPendingAnomaly,
} from '@/lib/orders/anomaly-confirmations'
import { registerCallbackHandler } from '../callback-router'
import { identifyTelegramUser } from '../identify-user'
import { anomalyConfirmationButtons } from '../buttons'
import { escapeHtml, notifyAllManagersDirect } from '../notify'

const ALLOWED_ANOMALY_ROLES = ['ADMIN', 'ADMIN_PRO', 'MANAGER'] as const

export interface AnomalyNotificationParams {
  confirmationId: string
  clientName: string
  locationName: string
  deliveryDate: Date
  mealType: MealType
  proposedPortions: number
  comparisonSource: 'baseline' | 'history'
  expected: { min: number; max: number; average: number; samples: number }
  reason: 'below_threshold' | 'above_threshold'
}

export function formatAnomalyNotification(params: AnomalyNotificationParams): string {
  const day = String(params.deliveryDate.getUTCDate()).padStart(2, '0')
  const month = String(params.deliveryDate.getUTCMonth() + 1).padStart(2, '0')
  const comparison = params.comparisonSource === 'baseline'
    ? `подтверждённый уровень: ${params.expected.average}`
    : `историческое среднее: ${params.expected.average} (выборка: ${params.expected.samples})`
  const reason = params.reason === 'below_threshold'
    ? `ниже допустимого коридора ${params.expected.min}–${params.expected.max}`
    : `выше допустимого коридора ${params.expected.min}–${params.expected.max}`

  return (
    `⚠️ <b>Аномалия порций</b>\n\n` +
    `Клиент: ${escapeHtml(params.clientName)}\n` +
    `Точка: ${escapeHtml(params.locationName)}\n` +
    `Дата: ${day}.${month}\n` +
    `Приём пищи: ${escapeHtml(MEAL_TYPE_LABELS[params.mealType])}\n` +
    `Предложено: <b>${params.proposedPortions} порций</b>\n` +
    `База сравнения: ${comparison}\n` +
    `Причина: ${reason}\n\n` +
    `Всё ок?`
  )
}

/** Пуш всем активным ADMIN/ADMIN_PRO/MANAGER с Telegram. */
export async function notifyManagersAboutAnomaly(
  params: AnomalyNotificationParams,
): Promise<void> {
  const result = await notifyAllManagersDirect(formatAnomalyNotification(params), {
    parseMode: 'HTML',
    replyMarkup: anomalyConfirmationButtons(params.confirmationId),
  })

  if (result.sentTo === 0) {
    throw new Error(
      `Уведомление об аномалии не доставлено: failed=${result.failed}, ` +
      `skippedNoTelegram=${result.skippedNoTelegram}`,
    )
  }
}

async function safeEditAnomalyMessage(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.editMessageText(text)
  } catch (error) {
    console.error('[anomaly-confirmation] editMessageText failed', error)
  }
}

export async function handleAnomalyConfirmationCallback(
  ctx: Context,
  action: string,
  confirmationId: string,
): Promise<void> {
  const user = await identifyTelegramUser(ctx)
  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден', show_alert: true })
    return
  }
  if (!(ALLOWED_ANOMALY_ROLES as readonly string[]).includes(user.role)) {
    await ctx.answerCallbackQuery({ text: 'Нет прав для подтверждения', show_alert: true })
    return
  }

  if (action === 'ok') {
    const result = await confirmPendingAnomaly({
      confirmationId,
      user: { id: user.id, role: user.role },
    })

    if (result.ok) {
      await safeEditAnomalyMessage(
        ctx,
        result.recovered
          ? `✅ Операция восстановлена: заказ уже создан, уровень обновлён: ${result.portions} порций`
          : `✅ Заказ создан, уровень обновлён: ${result.portions} порций`,
      )
      return
    }
    if (result.reason === 'already_processed') {
      await safeEditAnomalyMessage(ctx, 'Уже обработано')
      return
    }
    if (result.reason === 'already_processing') {
      await safeEditAnomalyMessage(ctx, 'Уже обрабатывается')
      return
    }
    if (result.reason === 'baseline_error' && result.orderId) {
      await safeEditAnomalyMessage(
        ctx,
        'Заказ создан, но уровень не обновлён — проверьте baseline',
      )
      return
    }

    await safeEditAnomalyMessage(
      ctx,
      `❌ Не удалось создать заказ: ${result.error ?? 'неизвестная ошибка'}`,
    )
    return
  }

  if (action === 'no') {
    const result = await rejectPendingAnomaly({ confirmationId, userId: user.id })
    await safeEditAnomalyMessage(
      ctx,
      result.ok ? 'Отклонено, ушло в inbox' : 'Уже обработано',
    )
    return
  }

  await ctx.answerCallbackQuery({ text: 'Неизвестное действие', show_alert: false })
}

registerCallbackHandler({
  scope: 'anom',
  handle: handleAnomalyConfirmationCallback,
})
