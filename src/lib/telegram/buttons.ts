import { InlineKeyboard } from 'grammy'
import { getTelegramEnv } from './env'

/**
 * Inline-кнопка «Открыть инбокс» → /inbox (список).
 *
 * Тех-долг 6.x: сейчас inboxButton(clientId) и inboxListButton() ведут на
 * один и тот же /inbox. Когда появится роут /inbox/<clientId>,
 * inboxButton подменим на нормальную ссылку (см. notify-managers.ts —
 * пуш приходит с конкретным клиентом).
 */
export function inboxListButton(): InlineKeyboard {
  const { appBaseUrl } = getTelegramEnv()
  return new InlineKeyboard().url('📥 Открыть инбокс', `${appBaseUrl}/inbox`)
}

export function inboxButton(_clientId: string): InlineKeyboard {
  return inboxListButton()
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
 * @param dateIso — YYYY-MM-DD; если передан, добавляется в URL как `?date=<...>`.
 * Тех-долг 5.9a-debt: страница /reports пока читает только `?preset=&from=&to=`,
 * параметр `?date=` ей неизвестен и будет проигнорирован. Кнопка ведёт на
 * общий /reports — фильтр на конкретный день доделаем отдельно.
 */
export function reportsButton(dateIso?: string): InlineKeyboard {
  const { appBaseUrl } = getTelegramEnv()
  const url = dateIso ? `${appBaseUrl}/reports?date=${dateIso}` : `${appBaseUrl}/reports`
  return new InlineKeyboard().url('📊 Открыть аналитику', url)
}
