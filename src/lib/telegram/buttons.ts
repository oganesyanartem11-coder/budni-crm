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

/**
 * Кнопка «Открыть импорт» — ведёт на /menu/imports/{id}.
 * Используется в push'ах workflow 8.7 (submit / reject AI-импорта меню).
 */
export function importButton(
  menuImportId: string,
  label = '📥 Открыть импорт в CRM'
): InlineKeyboard {
  const { appBaseUrl } = getTelegramEnv()
  return new InlineKeyboard().url(label, `${appBaseUrl}/menu/imports/${menuImportId}`)
}

/**
 * Недельная заявка на ручной проверке: «Внести как распознано» / «Отклонить».
 * callback_data `wsub:apply:<cuid>` / `wsub:reject:<cuid>` (submissionId).
 */
export function weeklySubmissionReviewButtons(submissionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Внести', `wsub:apply:${submissionId}`)
    .text('❌ Не вносить', `wsub:reject:${submissionId}`)
}

/**
 * «↩️ Отменить» под итогом внесения недельной заявки. id — ActivityLog
 * WEEKLY_SUBMISSION_APPLIED: откатывается ровно это применение.
 */
export function weeklyApplyUndoButton(applyLogId: string): InlineKeyboard {
  return new InlineKeyboard().text('↩️ Отменить', `wsub:undo:${applyLogId}`)
}

/**
 * MEGA-4b (П3): кнопки «Подтвердить»/«Отклонить» под пушем менеджеру о запросе
 * клиента на изменение/создание заказа. callback_data `poc:confirm:<cuid>` /
 * `poc:reject:<cuid>` (cuid ~25 символов, well under 64 байт).
 * Обрабатывается scope 'poc' (см. handlers/order-change.ts).
 */
export function orderChangeButtons(changeId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Подтвердить', `poc:confirm:${changeId}`)
    .text('❌ Отклонить', `poc:reject:${changeId}`)
}

/**
 * Запрос клиента на изменение заказов за период («с 7 по 14 +1 обед»):
 * одно сообщение — одна пара кнопок на весь план. id — ActivityLog запроса.
 */
export function rangeChangeButtons(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Подтвердить', `pocr:ok:${requestId}`)
    .text('❌ Отклонить', `pocr:no:${requestId}`)
}

/** Отдельный scope для ручной проверки аномального количества порций. */
export function anomalyConfirmationButtons(confirmationId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Да', `anom:ok:${confirmationId}`)
    .text('❌ Нет', `anom:no:${confirmationId}`)
}

/** Manager decision for a persisted Delivery 2.0 override request. */
export function deliveryOverrideButtons(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Подтвердить доставку', `dovr:approve:${requestId}`)
    .row()
    .text('❌ Отклонить', `dovr:reject:${requestId}`)
}
