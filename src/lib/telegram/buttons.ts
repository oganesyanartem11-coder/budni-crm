import { InlineKeyboard } from 'grammy'
import { getTelegramEnv } from './env'

/**
 * Inline-кнопка «Открыть инбокс» → общий список /inbox.
 * Для сводок и агрегатных уведомлений.
 */
export function inboxListButton(): InlineKeyboard {
  const { appBaseUrl } = getTelegramEnv()
  return new InlineKeyboard().url('📥 Открыть инбокс', `${appBaseUrl}/inbox`)
}

/**
 * Inline-кнопка → конкретный тред клиента (/inbox/<clientId>).
 * Используется в notify-managers, где push привязан к конкретному клиенту.
 */
export function inboxButton(clientId: string): InlineKeyboard {
  const { appBaseUrl } = getTelegramEnv()
  return new InlineKeyboard().url('💬 Открыть переписку', `${appBaseUrl}/inbox/${clientId}`)
}

export function productionSummaryButton(dateIso: string): InlineKeyboard {
  const { appBaseUrl } = getTelegramEnv()
  return new InlineKeyboard().url(
    '🍳 Производственная сводка',
    `${appBaseUrl}/production?date=${dateIso}`
  )
}

/**
 * Кнопка «Открыть аналитику».
 *
 * @param dateIso — YYYY-MM-DD; если передан, открывает отчёт за конкретный день
 * (preset=custom, from=to=date). Без даты — общий /reports с дефолтным пресетом.
 */
export function reportsButton(dateIso?: string): InlineKeyboard {
  const { appBaseUrl } = getTelegramEnv()
  const url = dateIso ? `${appBaseUrl}/reports?date=${dateIso}` : `${appBaseUrl}/reports`
  return new InlineKeyboard().url('📊 Открыть аналитику', url)
}

/**
 * Кнопка «Открыть заказ» — ведёт на детальную карточку /orders/{id}.
 * Используется в push'ах привязанных к конкретному заказу
 * (например, правка порций после 16:00).
 */
export function orderDetailButton(orderId: string, label = '📋 Открыть заказ'): InlineKeyboard {
  const { appBaseUrl } = getTelegramEnv()
  return new InlineKeyboard().url(label, `${appBaseUrl}/orders/${orderId}`)
}

/**
 * Кнопка «Открыть меню» — ведёт на /menu?cycle={id}.
 * Используется в push'ах PENDING_APPROVAL / APPROVED / REJECTED workflow.
 */
export function menuButton(
  menuCycleId: string,
  label = '📋 Открыть меню в CRM'
): InlineKeyboard {
  const { appBaseUrl } = getTelegramEnv()
  return new InlineKeyboard().url(label, `${appBaseUrl}/menu?cycle=${menuCycleId}`)
}
