/**
 * Фейк Telegram-слоя роли для полигона: сигнатуры один в один
 * с src/lib/boris-direct/telegram.ts, но никакой сети — сообщения падают
 * в ctx.alerts (kind='tg'), скорер потом оценивает «молчание на битых данных»
 * и качество алертов.
 *
 * ВАЖНО: в отличие от боевого модуля, при импорте НИЧЕГО не регистрируем
 * (боевой вызывает registerDirectCallbackHandler() side-effect'ом) —
 * решения по предложениям в полигоне принимает владелец-бот напрямую
 * через decideProposal.
 */

import type { Context } from 'grammy'
import type { InlineKeyboard } from 'grammy'
import { getCtx } from './context'
import type { SendTelegramMessageResult } from '../../src/lib/telegram/send'

/**
 * Подмена sendToDirectChat: текст — в алерты прогона (день = виртуальные
 * часы). replyMarkup (кнопки предложений) не сохраняем — владелец-бот
 * полигона решает по BorisDirectProposal, а не по кнопкам.
 */
export async function sendToDirectChat(
  text: string,
  _opts?: { replyMarkup?: InlineKeyboard }
): Promise<SendTelegramMessageResult> {
  const ctx = getCtx()
  ctx.alerts.push({ day: ctx.clockDay, kind: 'tg', text })
  return { ok: true }
}

/** В полигоне любой чат — «чат Директа» (команды владельца-бота проходят). */
export function isDirectChat(_chatId: string | number | undefined): boolean {
  return true
}

/** Мидлвара команд владельца: в полигоне просто пропускаем дальше. */
export async function handleDirectChatMessage(
  _ctx: Context,
  next: () => Promise<void>
): Promise<void> {
  return next()
}

/** Регистрация колбэков inline-кнопок: в полигоне no-op (кнопок нет). */
export function registerDirectCallbackHandler(): void {
  // Сознательно пусто — см. шапку файла.
}
