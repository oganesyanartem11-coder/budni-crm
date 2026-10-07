import type { MealType } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { sendBotMessage } from '@/lib/max/send-message'
import { MEAL_TYPE_RU } from '@/lib/boris/labels'
import {
  confirmPendingChange,
  rejectPendingChange,
} from '@/lib/order-changes/actions'
import { registerCallbackHandler } from '../callback-router'
import { notifyAllAdminProDirect, escapeHtml } from '../notify'
import { orderChangeButtons, rangeChangeButtons } from '../buttons'
import {
  confirmRangeRequest,
  formatRangeRequestText,
  rejectRangeRequest,
  type RangeRequestPayload,
} from '@/lib/order-changes/range-request'

/**
 * MEGA-4b (П3): TG-обработка запросов клиента на изменение/создание заказа.
 *
 *  1. notifyManagerAboutOrderChange — пуш всем ADMIN_PRO о новом запросе
 *     клиента (с кнопками «Подтвердить»/«Отклонить»). Вызывается из
 *     process-message (Subagent D) после парсинга и createPendingChange.
 *  2. callback-handler scope 'poc' — обработка нажатия кнопок:
 *     confirm → confirmPendingChange (EDIT/CREATE через Core) + автоответ
 *     клиенту; reject → rejectPendingChange + стандартный post-cutoff ответ.
 *
 * Callback регистрируется ПРИ ИМПОРТЕ модуля (side-effect), как scope 'wsub'
 * и 'boris'. Чтобы регистрация произошла, модуль импортируется за side-effect
 * в bot.ts (`import '@/lib/telegram/handlers/order-change'`).
 */

/** `Date` → `DD.MM` (UTC-компоненты — deliveryDate всегда UTC-полночь МСК-дня). */
function formatDateDDMM(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}`
}

export interface NotifyOrderChangeParams {
  changeId: string
  clientName: string
  locationName: string
  deliveryDate: Date
  mealType: MealType
  action: 'EDIT' | 'CREATE'
  proposedPortions: number
  currentPortions: number | null
  rawClientMessage: string
  parsedConfidence: number
}

/**
 * Чистый форматтер текста пуша менеджеру — без вызовов Bot API, чтобы
 * покрыть тестом. Динамику (имя клиента, локация, сообщение) экранируем под
 * HTML parseMode.
 */
export function formatOrderChangeNotification(params: NotifyOrderChangeParams): string {
  const {
    clientName,
    locationName,
    deliveryDate,
    mealType,
    action,
    proposedPortions,
    currentPortions,
    rawClientMessage,
    parsedConfidence,
  } = params

  const dateStr = formatDateDDMM(deliveryDate)
  const mealRu = MEAL_TYPE_RU[mealType]
  const rawTrimmed =
    rawClientMessage.length > 120 ? `${rawClientMessage.slice(0, 120)}…` : rawClientMessage

  const requestLine =
    action === 'EDIT'
      ? `изменить ${mealRu} на ${dateStr}: ${currentPortions ?? '?'} → ${proposedPortions} порций`
      : `создать ${mealRu} на ${dateStr}: ${proposedPortions} порций`

  return (
    `📩 От ${escapeHtml(clientName)} (${escapeHtml(locationName)}): "${escapeHtml(rawTrimmed)}"\n` +
    `\n` +
    `Запрос: ${requestLine}\n` +
    `\n` +
    `Confidence: ${parsedConfidence.toFixed(2)}`
  )
}

/**
 * Пуш всем ADMIN_PRO о новом запросе клиента на изменение заказа. С кнопками
 * «Подтвердить»/«Отклонить». Без задержки (управленческий канал — Telegram).
 */
export async function notifyManagerAboutOrderChange(
  params: NotifyOrderChangeParams,
): Promise<void> {
  const text = formatOrderChangeNotification(params)
  await notifyAllAdminProDirect(text, {
    replyMarkup: orderChangeButtons(params.changeId),
    parseMode: 'HTML',
  })
}

// Регистрация callback-handler'а ПРИ ИМПОРТЕ модуля (side-effect).
registerCallbackHandler({
  scope: 'poc',
  async handle(ctx, action, changeId) {
    // Маппинг telegram id → User (ADMIN_PRO, активный) — как в weekly-submission.
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
      await ctx.answerCallbackQuery({ text: 'Только для админов', show_alert: true })
      return
    }

    // editMessageText может упасть на нередактируемом/старом сообщении — не падаем.
    const safeEdit = async (text: string): Promise<void> => {
      try {
        await ctx.editMessageText(text)
      } catch (err) {
        console.error('[order-change] editMessageText failed', err)
      }
    }

    if (action === 'confirm') {
      const result = await confirmPendingChange({ changeId, confirmedById: user.id })

      if (result.ok) {
        await safeEdit(`✅ Готово: ${result.newPortions} порций. Клиент уведомлён.`)
        // Автоответ клиенту в MAX — с задержкой (как «живая» переписка).
        try {
          await sendBotMessage(result.clientMaxChatId, result.replyText, { delay: true })
        } catch (err) {
          console.error('[order-change] confirm sendBotMessage failed', err)
        }
      } else {
        switch (result.reason) {
          case 'expired':
            await safeEdit('⏰ Истёк срок 30 мин. Клиенту отправлен ответ.')
            break
          case 'already_processed':
            await safeEdit('✓ Уже обработано.')
            break
          case 'order_now_locked':
            await safeEdit('⚠️ Заказ уже в производстве. Обработай вручную.')
            break
          default:
            await safeEdit(`❌ Не получилось: ${result.reason}. Обработай вручную.`)
        }
      }
    } else if (action === 'reject') {
      const result = await rejectPendingChange({ changeId, confirmedById: user.id })

      if (result.ok) {
        await safeEdit('❌ Отклонено. Клиенту отправлен стандартный ответ.')
        try {
          await sendBotMessage(result.clientMaxChatId, result.postCutoffReplyText, {
            delay: true,
          })
        } catch (err) {
          console.error('[order-change] reject sendBotMessage failed', err)
        }
      } else {
        await safeEdit('✓ Уже обработано.')
      }
    } else {
      await ctx.answerCallbackQuery({ text: 'Неизвестное действие' })
      return
    }

    await ctx.answerCallbackQuery()
  },
})

// ─────────────────────────────────────────────────────────────────────
// Изменение на период («с 7 по 14 +1 обед»): одно сообщение со всем планом,
// одна пара кнопок (scope 'pocr', id — ActivityLog запроса).
// ─────────────────────────────────────────────────────────────────────

export async function notifyManagerAboutRangeChange(params: {
  requestId: string
  payload: RangeRequestPayload
}): Promise<void> {
  await notifyAllAdminProDirect(escapeHtml(formatRangeRequestText(params.payload)), {
    replyMarkup: rangeChangeButtons(params.requestId),
    parseMode: 'HTML',
  })
}

registerCallbackHandler({
  scope: 'pocr',
  async handle(ctx, action, requestId) {
    const telegramId = ctx.from?.id
    const user = telegramId
      ? await prisma.user.findFirst({
          where: { telegramChatId: String(telegramId), role: 'ADMIN_PRO', isActive: true },
          select: { id: true, role: true },
        })
      : null
    if (!user) {
      await ctx.answerCallbackQuery({ text: 'Только для админов', show_alert: true })
      return
    }

    const result =
      action === 'ok'
        ? await confirmRangeRequest({ requestId, actor: user })
        : action === 'no'
          ? await rejectRangeRequest({ requestId, actor: user })
          : null
    if (!result) {
      await ctx.answerCallbackQuery({ text: 'Неизвестное действие' })
      return
    }
    if (!result.ok) {
      await ctx.answerCallbackQuery({
        text: result.reason === 'not_found' ? 'Запрос не найден' : 'Уже обработано',
        show_alert: true,
      })
      return
    }

    try {
      await ctx.editMessageText(result.managerText)
    } catch (err) {
      console.error('[order-change] range editMessageText failed', err)
    }
    if (result.clientReply && result.clientChatId) {
      await sendBotMessage(result.clientChatId, result.clientReply, { delay: true }).catch((err) =>
        console.error('[order-change] range client reply failed', err),
      )
    }
    await ctx.answerCallbackQuery({ text: action === 'ok' ? 'Готово' : 'Отклонено' })
  },
})
