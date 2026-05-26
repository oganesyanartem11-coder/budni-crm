import type { Context } from 'grammy'

/**
 * Generic роутер для inline-кнопок (callback_query) в TG-боте.
 *
 * Формат callback_data: `<scope>:<action>:<id>` (max 64 байта по Telegram API).
 * Примеры: `boris:confirm:cmpending123`, `boris:cancel:cmpending123`.
 *
 * scope `boris` зарезервирован для AI-агента "Action-Борис".
 * Другие scope — для будущих фич.
 *
 * Использование:
 *   registerCallbackHandler({ scope: 'boris', handle: async (ctx, action, id) => {...} })
 *   bot.on('callback_query:data', dispatchCallback)
 */

export interface CallbackHandler {
  scope: string
  handle: (ctx: Context, action: string, id: string) => Promise<void>
}

const handlers: CallbackHandler[] = []

export function registerCallbackHandler(handler: CallbackHandler): void {
  const existingIndex = handlers.findIndex((h) => h.scope === handler.scope)
  if (existingIndex >= 0) {
    console.warn(`[callback-router] handler для scope ${handler.scope} переопределён`)
    handlers[existingIndex] = handler
  } else {
    handlers.push(handler)
  }
  console.log(`[callback-router] зарегистрирован scope=${handler.scope}`)
}

export async function dispatchCallback(ctx: Context): Promise<void> {
  let answered = false
  const safeAnswer = async (
    args?: { text?: string; show_alert?: boolean }
  ): Promise<void> => {
    if (answered) return
    answered = true
    try {
      if (args) {
        await ctx.answerCallbackQuery(args)
      } else {
        await ctx.answerCallbackQuery()
      }
    } catch (err) {
      // 400 от TG (например, callback query слишком старый) — логируем, не падаем
      console.error('[callback-router] answerCallbackQuery failed', err)
    }
  }

  const data = ctx.callbackQuery?.data
  if (!data) {
    await safeAnswer({ text: 'Неизвестное действие', show_alert: false })
    return
  }

  // id может содержать ':' — сегментируем первые два, остальное склеиваем.
  const [scope, action, ...idParts] = data.split(':')
  const id = idParts.join(':')

  if (!scope || !action || !id) {
    console.warn(`[callback-router] битый формат data=${data}`)
    await safeAnswer({ text: 'Неизвестное действие', show_alert: false })
    return
  }

  const handler = handlers.find((h) => h.scope === scope)
  if (!handler) {
    console.warn(`[callback-router] unknown scope=${scope} data=${data}`)
    await safeAnswer({ text: 'Неизвестное действие', show_alert: false })
    return
  }

  console.log(`[callback-router] dispatch scope=${scope} action=${action} id=${id}`)

  try {
    await handler.handle(ctx, action, id)
  } catch (err) {
    console.error(
      `[callback-router] handler error scope=${scope} action=${action}`,
      err
    )
    await safeAnswer({ text: 'Ошибка обработки', show_alert: true })
    return
  }

  // Финальный «no-op» answer на случай, если handler не ответил сам —
  // иначе у пользователя на кнопке висит loading-спиннер до 15 сек.
  await safeAnswer()
}
