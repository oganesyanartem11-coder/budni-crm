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

export function reportsButton(): InlineKeyboard {
  const { appBaseUrl } = getTelegramEnv()
  return new InlineKeyboard().url('📊 Открыть аналитику', `${appBaseUrl}/reports`)
}
