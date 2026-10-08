import type { Context } from 'grammy'
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
import { createInboxItem } from '@/lib/bot/create-inbox-item'
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
  /**
   * Клиент запроса. Нужен, чтобы при недоставке пуша (sentTo=0) завести
   * InboxItem HIGH — запрос не должен потеряться тихо. Без clientId
   * недоставка только логируется.
   */
  clientId?: string
  conversationId?: string | null
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

export interface NotifyManagerResult {
  /** Скольким ADMIN_PRO пуш реально доставлен. */
  sentTo: number
  /** InboxItem, заведённый этой функцией (HIGH при недоставке / NORMAL для периода). */
  inboxItemId: string | null
}

export const ORDER_CHANGE_UNDELIVERED_REASON =
  'Запрос клиента на изменение заказа — уведомление в Telegram не доставлено'

/** Доставка пуша всем ADMIN_PRO; throw → считаем как 0 доставленных. */
async function pushToAdminPro(
  text: string,
  replyMarkup: ReturnType<typeof orderChangeButtons>,
  tag: string,
): Promise<number> {
  try {
    const r = await notifyAllAdminProDirect(text, { replyMarkup, parseMode: 'HTML' })
    return r.sentTo
  } catch (err) {
    console.error(`[order-change] ${tag} notifyAllAdminProDirect failed`, err)
    return 0
  }
}

/** Пуш никому не доставлен → InboxItem HIGH, чтобы запрос не потерялся. */
async function inboxForUndelivered(params: {
  clientId?: string
  conversationId?: string | null
  clientMessage: string
  ref: string
  tag: string
}): Promise<string | null> {
  if (!params.clientId) {
    console.error(
      `[order-change] ${params.tag} LOST: пуш не доставлен ни одному ADMIN_PRO, clientId не передан (${params.ref})`,
    )
    return null
  }
  try {
    const item = await createInboxItem({
      clientId: params.clientId,
      conversationId: params.conversationId ?? null,
      reason: 'NON_NUMERIC',
      humanReason: `${ORDER_CHANGE_UNDELIVERED_REASON} (${params.ref})`,
      priority: 'HIGH',
      clientMessage: params.clientMessage,
    })
    return item.id
  } catch (err) {
    console.error(`[order-change] ${params.tag} inbox(HIGH) create failed`, err)
    return null
  }
}

/**
 * Пуш всем ADMIN_PRO о новом запросе клиента на изменение заказа. С кнопками
 * «Подтвердить»/«Отклонить». Без задержки (управленческий канал — Telegram).
 * Не доставлен никому (sentTo=0) и передан clientId → InboxItem HIGH.
 */
export async function notifyManagerAboutOrderChange(
  params: NotifyOrderChangeParams,
): Promise<NotifyManagerResult> {
  const text = formatOrderChangeNotification(params)
  const sentTo = await pushToAdminPro(text, orderChangeButtons(params.changeId), 'single')
  if (sentTo > 0) return { sentTo, inboxItemId: null }
  const inboxItemId = await inboxForUndelivered({
    clientId: params.clientId,
    conversationId: params.conversationId,
    clientMessage: params.rawClientMessage,
    ref: `Pending order change: ${params.changeId}`,
    tag: 'single',
  })
  return { sentTo, inboxItemId }
}

/** Контекст запроса для итоговой правки сообщения: «ХАЛВА: обед на 08.10». */
async function loadChangeContext(changeId: string): Promise<string | null> {
  try {
    const change = await prisma.pendingOrderChange.findUnique({
      where: { id: changeId },
      select: {
        deliveryDate: true,
        mealType: true,
        client: { select: { name: true } },
      },
    })
    if (!change) return null
    return `${change.client.name}: ${MEAL_TYPE_RU[change.mealType]} на ${formatDateDDMM(change.deliveryDate)}`
  } catch (err) {
    console.error('[order-change] load change context failed', err)
    return null
  }
}

/** Отправка клиенту без «живой» задержки 15–30 с: менеджер ждёт итог. */
async function sendClientReply(chatId: string, text: string, tag: string): Promise<boolean> {
  if (!chatId) return false
  try {
    await sendBotMessage(chatId, text, { delay: false })
    return true
  } catch (err) {
    console.error(`[order-change] ${tag} sendBotMessage failed`, err)
    return false
  }
}

const CLIENT_SENT = 'Клиенту отправлено.'
const CLIENT_NOT_SENT = '⚠️ Клиенту не отправилось — напиши ему сам.'

/** Безопасный answerCallbackQuery: «query is too old» не должен ронять обработку. */
async function safeAnswer(
  ctx: Context,
  args?: { text?: string; show_alert?: boolean },
): Promise<void> {
  try {
    if (args) await ctx.answerCallbackQuery(args)
    else await ctx.answerCallbackQuery()
  } catch (err) {
    console.error('[order-change] answerCallbackQuery failed', err)
  }
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

    if (action !== 'confirm' && action !== 'reject') {
      await ctx.answerCallbackQuery({ text: 'Неизвестное действие' })
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

    // Кто/что — чтобы после правки в чате осталось, о каком запросе речь.
    const about = (await loadChangeContext(changeId)) ?? 'Запрос клиента'

    if (action === 'confirm') {
      const result = await confirmPendingChange({ changeId, confirmedById: user.id })

      if (result.ok) {
        // Сначала снимаем спиннер с кнопки, потом медленная работа.
        await safeAnswer(ctx, { text: 'Готово' })
        const sent = await sendClientReply(result.clientMaxChatId, result.replyText, 'confirm')
        await safeEdit(
          `✅ ${about} — ${result.newPortions} порций. ${sent ? CLIENT_SENT : CLIENT_NOT_SENT}`,
        )
        return
      }

      switch (result.reason) {
        case 'expired':
          await safeAnswer(ctx, { text: 'Запрос истёк', show_alert: true })
          await safeEdit(
            `⏰ ${about}: запрос истёк (30 мин) — ничего не применено. ` +
              'Клиенту уходит автоответ «не успели обработать»; если актуально — свяжись с ним.',
          )
          break
        case 'already_processed':
          await safeAnswer(ctx, { text: 'Уже обработано' })
          await safeEdit(`✓ ${about}: уже обработано.`)
          break
        case 'order_now_locked':
          await safeAnswer(ctx, { text: 'Заказ уже в производстве', show_alert: true })
          await safeEdit(`⚠️ ${about}: заказ уже в производстве, ничего не применено. Обработай вручную.`)
          break
        default:
          await safeAnswer(ctx, { text: 'Не получилось', show_alert: true })
          await safeEdit(
            `❌ ${about}: не получилось (${result.reason}${result.details ? `: ${result.details}` : ''}). Обработай вручную.`,
          )
      }
      return
    }

    // reject
    const result = await rejectPendingChange({ changeId, confirmedById: user.id })
    if (!result.ok) {
      await safeAnswer(ctx, { text: 'Уже обработано' })
      await safeEdit(`✓ ${about}: уже обработано.`)
      return
    }
    await safeAnswer(ctx, { text: 'Отклонено' })
    const sent = await sendClientReply(result.clientMaxChatId, result.postCutoffReplyText, 'reject')
    await safeEdit(
      `❌ ${about}: отклонено, заказ не меняли. ${sent ? 'Клиенту отправлен стандартный ответ.' : CLIENT_NOT_SENT}`,
    )
  },
})

// ─────────────────────────────────────────────────────────────────────
// Изменение на период («с 7 по 14 +1 обед»): одно сообщение со всем планом,
// одна пара кнопок (scope 'pocr', id — ActivityLog запроса).
// ─────────────────────────────────────────────────────────────────────

/**
 * Пуш менеджерам о запросе на период. Если передан clientId — запрос всегда
 * попадает в Inbox (как и однодневный): NORMAL при доставленном пуше, HIGH —
 * если пуш не доставлен ни одному ADMIN_PRO.
 */
export async function notifyManagerAboutRangeChange(params: {
  requestId: string
  payload: RangeRequestPayload
  clientId?: string
  conversationId?: string | null
}): Promise<NotifyManagerResult> {
  const sentTo = await pushToAdminPro(
    escapeHtml(formatRangeRequestText(params.payload)),
    rangeChangeButtons(params.requestId),
    'range',
  )
  if (sentTo === 0) {
    const inboxItemId = await inboxForUndelivered({
      clientId: params.clientId,
      conversationId: params.conversationId,
      clientMessage: params.payload.rawText,
      ref: `Range order change: ${params.requestId}`,
      tag: 'range',
    })
    return { sentTo, inboxItemId }
  }
  if (!params.clientId) return { sentTo, inboxItemId: null }
  try {
    const item = await createInboxItem({
      clientId: params.clientId,
      conversationId: params.conversationId ?? null,
      reason: 'NON_NUMERIC',
      humanReason: `Изменение на период — ждёт решения: ${params.requestId}`,
      priority: 'NORMAL',
      clientMessage: params.payload.rawText,
    })
    return { sentTo, inboxItemId: item.id }
  } catch (err) {
    console.error('[order-change] range inbox(NORMAL) create failed', err)
    return { sentTo, inboxItemId: null }
  }
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

    // Сначала снимаем спиннер, потом клиенту и правка сообщения.
    await safeAnswer(ctx, { text: action === 'ok' ? 'Готово' : 'Отклонено' })
    let clientNote = ''
    if (result.clientReply && result.clientChatId) {
      const sent = await sendClientReply(result.clientChatId, result.clientReply, 'range')
      clientNote = sent ? `\n${CLIENT_SENT}` : `\n${CLIENT_NOT_SENT}`
    }
    try {
      await ctx.editMessageText(`${result.managerText}${clientNote}`)
    } catch (err) {
      console.error('[order-change] range editMessageText failed', err)
    }
  },
})
