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
import { ANOMALY_CHECK_ENABLED } from '@/lib/orders/anomaly-constants'
import { prisma } from '@/lib/db/prisma'

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

async function safeAnswer(
  ctx: Context,
  args: { text: string; show_alert?: boolean },
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(args)
  } catch (error) {
    console.error('[anomaly-confirmation] answerCallbackQuery failed', error)
  }
}

/**
 * «ХАЛВА · Офис, обед на 07.08» — чтобы после правки сообщения было видно,
 * о каком заказе речь. Сбой загрузки — нейтральная подпись.
 */
async function loadAnomalyContext(confirmationId: string): Promise<string> {
  try {
    const c = await prisma.pendingAnomalyConfirmation.findUnique({
      where: { id: confirmationId },
      select: {
        deliveryDate: true,
        mealType: true,
        client: { select: { name: true } },
        location: { select: { name: true } },
      },
    })
    if (!c) return 'Аномалия порций'
    const day = String(c.deliveryDate.getUTCDate()).padStart(2, '0')
    const month = String(c.deliveryDate.getUTCMonth() + 1).padStart(2, '0')
    const meal = MEAL_TYPE_LABELS[c.mealType]?.toLowerCase() ?? c.mealType
    return `${c.client.name} · ${c.location.name}, ${meal} на ${day}.${month}`
  } catch (error) {
    console.error('[anomaly-confirmation] load context failed', error)
    return 'Аномалия порций'
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
  if (action !== 'ok' && action !== 'no') {
    await ctx.answerCallbackQuery({ text: 'Неизвестное действие', show_alert: false })
    return
  }

  if (action === 'ok') {
    const result = await confirmPendingAnomaly({
      confirmationId,
      user: { id: user.id, role: user.role },
    })
    // Спиннер снимаем сразу после действия, правка — следом.
    await safeAnswer(
      ctx,
      result.ok
        ? { text: 'Готово' }
        : result.reason === 'already_processed' || result.reason === 'already_processing'
          ? { text: 'Уже обработано' }
          : { text: 'Не получилось', show_alert: true },
    )
    const about = await loadAnomalyContext(confirmationId)

    if (result.ok && !ANOMALY_CHECK_ENABLED) {
      // Старая кнопка, висевшая до отключения проверки: число применено.
      await safeEditAnomalyMessage(
        ctx,
        `✅ ${about}: проверка аномалий отключена, число принято: ${result.portions} порций`,
      )
      return
    }
    if (!result.ok && result.reason === 'already_processed' && !ANOMALY_CHECK_ENABLED) {
      await safeEditAnomalyMessage(ctx, `${about}: проверка аномалий отключена, число уже принято`)
      return
    }

    if (result.ok) {
      await safeEditAnomalyMessage(
        ctx,
        result.recovered
          ? `✅ ${about}: операция восстановлена — заказ уже создан, уровень обновлён: ${result.portions} порций`
          : `✅ ${about}: заказ создан, уровень обновлён: ${result.portions} порций`,
      )
      return
    }
    if (result.reason === 'already_processed') {
      await safeEditAnomalyMessage(ctx, `✓ ${about}: уже обработано`)
      return
    }
    if (result.reason === 'already_processing') {
      await safeEditAnomalyMessage(ctx, `⏳ ${about}: уже обрабатывается`)
      return
    }
    if (result.reason === 'baseline_error' && result.orderId) {
      await safeEditAnomalyMessage(
        ctx,
        `⚠️ ${about}: заказ создан, но уровень не обновлён — проверьте baseline`,
      )
      return
    }

    await safeEditAnomalyMessage(
      ctx,
      `❌ ${about}: не удалось создать заказ: ${result.error ?? 'неизвестная ошибка'}`,
    )
    return
  }

  // action === 'no'
  const result = await rejectPendingAnomaly({ confirmationId, userId: user.id })
  await safeAnswer(ctx, { text: result.ok ? 'Отклонено' : 'Уже обработано' })
  const about = await loadAnomalyContext(confirmationId)
  await safeEditAnomalyMessage(
    ctx,
    result.ok
      ? `❌ ${about}: отклонено, заказ не создан — ушло в inbox`
      : `✓ ${about}: уже обработано`,
  )
}

registerCallbackHandler({
  scope: 'anom',
  handle: handleAnomalyConfirmationCallback,
})
