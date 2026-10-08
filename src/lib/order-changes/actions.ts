import type { MealType } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { findActiveOrder } from '@/lib/db/queries/orders'
import { createOneTimeOrderCore } from '@/app/(app)/orders/actions'
import { setOrderPortionsForClient } from '@/lib/orders/client-portions'
import { getPostCutoffReply } from '@/lib/bot/templates'
import { formatCutoff, DEFAULT_CUTOFF, getClientCutoffForDate } from '@/lib/utils/cutoff'
import { getActiveMaxChatIdForClient } from '@/lib/bot/max-users'

/**
 * MEGA-4b (П3): бизнес-логика жизненного цикла PendingOrderChange —
 * запрос клиента в MAX на изменение/создание заказа, который менеджер
 * подтверждает/отклоняет кнопкой в Telegram (либо протухает по cron).
 *
 * Все мутации статуса делаются атомарным updateMany по condition
 * status='PENDING' — это claim, который защищает от двойного подтверждения
 * (manager × cron, или два менеджера одновременно).
 */

/**
 * Локальная константа автоответа клиенту при протухании запроса (30 мин).
 * Хранится здесь, а не в templates.ts (вне зоны этого спринта).
 */
export const EXPIRED_REPLY =
  'Спасибо! Не успели обработать запрос. Если вопрос актуален — напомните, посмотрим что можно сделать.'

const TTL_MINUTES = 30

/** `Date` → `DD.MM` (UTC-компоненты — deliveryDate всегда UTC-полночь МСК-дня). */
function formatDateDDMM(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}`
}

export interface CreatePendingChangeParams {
  clientId: string
  locationId: string
  deliveryDate: Date
  mealType: MealType
  action: 'EDIT' | 'CREATE'
  proposedPortions: number
  /** «Добавьте N»: изменение со знаком — итог пересчитается при подтверждении. */
  deltaPortions?: number | null
  currentOrderId?: string
  currentPortions?: number | null
  sourceMaxChatId: string
  rawClientMessage: string
  parsedConfidence: number
}

/**
 * Создаёт PENDING-запись с TTL 30 мин. Возвращает id + expiresAt для
 * последующего notify менеджеру.
 */
export async function createPendingChange(
  params: CreatePendingChangeParams,
): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000)

  const record = await prisma.pendingOrderChange.create({
    data: {
      clientId: params.clientId,
      locationId: params.locationId,
      deliveryDate: params.deliveryDate,
      mealType: params.mealType,
      action: params.action,
      proposedPortions: params.proposedPortions,
      deltaPortions: params.deltaPortions ?? null,
      currentOrderId: params.currentOrderId ?? null,
      currentPortions: params.currentPortions ?? null,
      sourceMaxChatId: params.sourceMaxChatId,
      rawClientMessage: params.rawClientMessage,
      parsedConfidence: params.parsedConfidence,
      expiresAt,
      // status PENDING — default.
    },
    select: { id: true, expiresAt: true },
  })

  return { id: record.id, expiresAt: record.expiresAt }
}

export type ConfirmPendingChangeResult =
  | {
      ok: true
      action: 'EDIT' | 'CREATE'
      orderId: string
      newPortions: number
      replyText: string
      clientMaxChatId: string
    }
  | {
      ok: false
      reason:
        | 'expired'
        | 'already_processed'
        | 'order_now_locked'
        | 'create_failed'
        | 'edit_failed'
        | 'menu_not_found'
      details?: string
    }

/** Статусы, в которых заказ уже «уехал в производство» — править нельзя. */
const LOCKED_FOR_EDIT_STATUSES = new Set([
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
])

/**
 * Менеджер нажал «Подтвердить». Атомарно клеймит запись, выполняет EDIT/CREATE
 * через Core-экшены (от лица confirmedById с ролью ADMIN_PRO), помечает
 * EXECUTED/FAILED и возвращает текст автоответа клиенту.
 */
export async function confirmPendingChange(params: {
  changeId: string
  confirmedById: string
}): Promise<ConfirmPendingChangeResult> {
  const { changeId, confirmedById } = params
  const now = new Date()

  // 1. Атомарный claim: PENDING + ещё не протух → CONFIRMED.
  const claim = await prisma.pendingOrderChange.updateMany({
    where: { id: changeId, status: 'PENDING', expiresAt: { gt: now } },
    data: { status: 'CONFIRMED', confirmedById, confirmedAt: now },
  })

  if (claim.count !== 1) {
    const existing = await prisma.pendingOrderChange.findUnique({
      where: { id: changeId },
      select: { status: true, expiresAt: true },
    })
    if (!existing) return { ok: false, reason: 'already_processed' }
    // Протух (cron уже пометил EXPIRED или ещё не успел) — честно «истёк»,
    // а не «уже обработано»: менеджер решил бы, что заказ изменён.
    if (existing.status === 'EXPIRED' || (existing.status === 'PENDING' && existing.expiresAt < now)) {
      return { ok: false, reason: 'expired' }
    }
    return { ok: false, reason: 'already_processed' }
  }

  // 2. Загрузить полную запись (после успешного claim).
  const change = await prisma.pendingOrderChange.findUnique({
    where: { id: changeId },
  })
  if (!change) {
    // Не должно случиться (claim только что прошёл), но защищаемся.
    return { ok: false, reason: 'already_processed' }
  }

  const dateStr = formatDateDDMM(change.deliveryDate)
  // 7.55: резолвим активного пользователя на момент отправки; sourceMaxChatId —
  // снимок-аудит и fallback, если активного пользователя нет.
  const clientMaxChatId =
    (await getActiveMaxChatIdForClient(change.clientId)) ?? change.sourceMaxChatId
  const actor = { id: confirmedById, role: 'ADMIN_PRO' as const }

  // Хелперы пометки итогового статуса.
  const markFailed = async (failureReason: string): Promise<void> => {
    await prisma.pendingOrderChange.update({
      where: { id: changeId },
      data: { status: 'FAILED', failureReason },
    })
  }
  const markExecuted = async (): Promise<void> => {
    await prisma.pendingOrderChange.update({
      where: { id: changeId },
      data: { status: 'EXECUTED', executedAt: new Date() },
    })
  }

  let resolvedAction: 'EDIT' | 'CREATE' = change.action
  let orderId: string | null = null
  let newPortions = change.proposedPortions

  try {

  // 3. EDIT (если есть currentOrderId).
  if (change.action === 'EDIT' && change.currentOrderId) {
    const active = await findActiveOrder({
      clientId: change.clientId,
      locationId: change.locationId,
      mealType: change.mealType,
      deliveryDate: change.deliveryDate,
    })

    if (!active) {
      // Заказа больше нет → авто-fallback на CREATE (ниже).
      resolvedAction = 'CREATE'
    } else if (LOCKED_FOR_EDIT_STATUSES.has(active.status)) {
      await markFailed('order_now_locked')
      return { ok: false, reason: 'order_now_locked' }
    } else {
      if (change.deltaPortions != null) {
        const unanswered =
          active.portions === 0 && (active.status === 'PENDING_CONFIRMATION' || active.status === 'DRAFT')
        const total = active.portions + change.deltaPortions
        if (unanswered || total < 0) {
          const why = unanswered ? 'клиент ещё не назвал число — не к чему прибавить' : `в заказе ${active.portions}, убрать ${-change.deltaPortions} нельзя`
          await markFailed(why)
          return { ok: false, reason: 'edit_failed', details: why }
        }
        newPortions = total
      }
      // Общий путь «число клиента → заказ»: PENDING (ещё без ответа) →
      // подтверждаем с числом, 0 («уберите все») → отмена, УПД — не трогаем.
      // Голый editOrderPortionsCore падал на PENDING-заказах.
      const result = await setOrderPortionsForClient(actor, {
        orderId: active.id,
        portions: newPortions,
        via: 'order_change',
      })
      if (!result.ok) {
        const error = result.skipped ? result.reason : result.error
        await markFailed(error)
        return { ok: false, reason: 'edit_failed', details: error }
      }
      orderId = active.id
    }
  }

  // 4. CREATE (явный CREATE или EDIT-fallback).
  if (resolvedAction === 'CREATE' && orderId === null && change.deltaPortions != null) {
    const why = 'заказа на эту дату уже нет — не к чему прибавить'
    await markFailed(why)
    return { ok: false, reason: 'edit_failed', details: why }
  }
  if (resolvedAction === 'CREATE' && orderId === null) {
    const result = await createOneTimeOrderCore(actor, {
      clientId: change.clientId,
      locationId: change.locationId,
      mealType: change.mealType,
      deliveryDate: change.deliveryDate,
      portions: change.proposedPortions,
      source: 'CLIENT_REQUEST',
    })
    if (!result.ok) {
      await markFailed(result.error)
      const reason =
        result.error.includes('меню') || result.error.includes('цен')
          ? 'menu_not_found'
          : 'create_failed'
      return { ok: false, reason, details: result.error }
    }
    orderId = result.data.orderId
  }
  } catch (err) {
    // Не оставляем запрос в CONFIRMED навсегда (кнопка потом говорила бы
    // «уже обработано», хотя ничего не применилось).
    const detail = err instanceof Error ? err.message : String(err)
    await markFailed(detail).catch(() => {})
    return { ok: false, reason: 'edit_failed', details: detail }
  }

  // orderId всегда установлен на этом этапе (EDIT-успех или CREATE-успех).
  if (orderId === null) {
    await markFailed('no_order_resolved')
    return { ok: false, reason: 'create_failed', details: 'no_order_resolved' }
  }

  // 5. EXECUTED.
  await markExecuted()

  // 6. Текст автоответа клиенту.
  const replyText =
    resolvedAction === 'EDIT'
      ? `Обновили, теперь ${newPortions} порций на ${dateStr}.`
      : `Записали, ${newPortions} порций на ${dateStr}. Спасибо!`

  return {
    ok: true,
    action: resolvedAction,
    orderId,
    newPortions,
    replyText,
    clientMaxChatId,
  }
}

export type RejectPendingChangeResult =
  | { ok: true; clientMaxChatId: string; postCutoffReplyText: string }
  | { ok: false; reason: 'already_processed' }

/**
 * Менеджер нажал «Отклонить». Атомарно клеймит PENDING → REJECTED и
 * возвращает стандартный post-cutoff ответ клиенту.
 */
export async function rejectPendingChange(params: {
  changeId: string
  confirmedById: string
}): Promise<RejectPendingChangeResult> {
  const { changeId, confirmedById } = params
  const now = new Date()

  const claim = await prisma.pendingOrderChange.updateMany({
    where: { id: changeId, status: 'PENDING' },
    data: { status: 'REJECTED', rejectedAt: now, confirmedById },
  })

  if (claim.count !== 1) {
    return { ok: false, reason: 'already_processed' }
  }

  const change = await prisma.pendingOrderChange.findUnique({
    where: { id: changeId },
    select: {
      sourceMaxChatId: true,
      clientId: true,
      deliveryDate: true,
      locationId: true,
      client: {
        select: {
          locations: {
            select: {
              id: true,
              sameDayDelivery: true,
              cutoffHourMsk: true,
              cutoffMinuteMsk: true,
              isActive: true,
            },
          },
        },
      },
    },
  })
  // change не может быть null после успешного claim, но защищаемся типом.
  // 7.55: резолв активного на момент отправки; sourceMaxChatId — снимок/fallback.
  const clientMaxChatId = change
    ? ((await getActiveMaxChatIdForClient(change.clientId)) ?? change.sourceMaxChatId)
    : ''

  // V-postcutoff-default (7.53 F-A): персональный cut-off локации заказа вместо
  // хардкода 16:00. getClientCutoffForDate сам падает на DEFAULT_CUTOFF, если
  // локация не same-day / доставка не сегодня / не резолвится.
  const cutoff = change
    ? getClientCutoffForDate({
        client: { locations: change.client.locations },
        deliveryDate: change.deliveryDate,
        locationId: change.locationId,
        now,
      })
    : DEFAULT_CUTOFF
  const postCutoffReplyText = getPostCutoffReply(formatCutoff(cutoff))

  return { ok: true, clientMaxChatId, postCutoffReplyText }
}

export interface ExpirePendingChangesResult {
  expired: { id: string; clientMaxChatId: string; postCutoffReplyText: string }[]
}

/**
 * Cron-обработчик: помечает все протухшие PENDING-запросы как EXPIRED и
 * возвращает список для отправки клиентам автоответа.
 *
 * Гонку с ручным confirm/reject закрываем условием status='PENDING' в
 * updateMany — если менеджер успел нажать раньше, запись уже не PENDING и
 * не попадёт в claim. Для каждого id делаем индивидуальный claim, чтобы в
 * результат попали ТОЛЬКО реально помеченные записи.
 */
export async function expirePendingChanges(): Promise<ExpirePendingChangesResult> {
  const now = new Date()

  const candidates = await prisma.pendingOrderChange.findMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    select: { id: true, clientId: true, sourceMaxChatId: true },
  })

  const expired: ExpirePendingChangesResult['expired'] = []

  for (const c of candidates) {
    const claim = await prisma.pendingOrderChange.updateMany({
      where: { id: c.id, status: 'PENDING' },
      data: { status: 'EXPIRED', expiredAt: now },
    })
    if (claim.count === 1) {
      // 7.55: резолв активного на момент отправки; sourceMaxChatId — снимок/fallback.
      const clientMaxChatId =
        (await getActiveMaxChatIdForClient(c.clientId)) ?? c.sourceMaxChatId
      expired.push({
        id: c.id,
        clientMaxChatId,
        postCutoffReplyText: EXPIRED_REPLY,
      })
    }
  }

  return { expired }
}
