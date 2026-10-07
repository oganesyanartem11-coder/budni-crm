import type { ClientMealConfig, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { ClientWithBotContext } from '@/lib/bot/max-users'
import { promoteToActiveByChatId } from '@/lib/bot/max-users'
import { parseClientResponse } from '@/lib/llm/parser'
import { getClientStats } from '@/lib/orders/client-stats'
import { LLM_CONFIDENCE_THRESHOLD } from '@/lib/orders/anomaly-constants'
import {
  firstEditableDeliveryDate,
  resolveSystemActor,
  setOrderPortionsForClient,
} from '@/lib/orders/client-portions'
import { isScheduledForDate } from '@/lib/orders/generate-orders'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import { sendBotMessage } from '@/lib/max/send-message'
import { escapeHtml, notifyProductionChannel } from '@/lib/telegram/notify'
import { hasDateHint } from './extract-delivery-date'

const NUMBER_WORD_RE = /(^|[^а-яё])(один|одн[аоу]|дв[аеу]|двое|три|трое|четыр|пят[ьи]|шест|сем[ьи]|восем|девят|десят)/i
import { logBotMessage } from './log-message'

/**
 * STICKY «По последнему числу»: число клиента становится постоянным количеством
 * (ClientMealConfig.fixedPortions), пока он не напишет новое. Заказы генерятся
 * как FIXED, ежедневных вопросов нет.
 *
 * Сообщение без числа, с датой («в пятницу 20» — разовая правка) или с 0
 * («завтра не нужно») сюда не относится → handleStickyMessage возвращает null,
 * и сообщение идёт обычной spontaneous-веткой.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** Выше — почти наверняка не количество порций («офис 305»), отдаём менеджеру. */
const MAX_STICKY_PORTIONS = 300
const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const
const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'] as const

/** @db.Date (UTC-полночь МСК-дня) → «пт, 2 окт». */
export function formatStickyDate(date: Date): string {
  return `${WEEKDAY_SHORT[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]}`
}

/** Клиент целиком на STICKY: есть STICKY-конфиг и нет DYNAMIC/WEEKLY. */
export function isStickyClient(client: ClientWithBotContext): boolean {
  const configs = client.locations.flatMap((l) => l.mealConfigs.filter((c) => c.isActive))
  return (
    configs.some((c) => c.orderType === 'STICKY') &&
    !configs.some((c) => c.orderType === 'DYNAMIC' || c.orderType === 'WEEKLY')
  )
}

/** Первый день по расписанию конфига, начиная с from (до 14 дней), иначе from. */
function firstScheduledDate(config: ClientMealConfig, from: Date): Date {
  for (let i = 0; i < 14; i++) {
    const day = new Date(from.getTime() + i * DAY_MS)
    if (isScheduledForDate(config, day)) return day
  }
  return from
}

interface StickyChange {
  locationName: string
  portions: number
  changed: boolean
  effectiveFrom: Date
}

export async function handleStickyMessage(
  client: ClientWithBotContext,
  text: string,
  senderChatId: string,
  now: Date = new Date(),
): Promise<{ reply: string; changed: boolean } | null> {
  // «уберите одну» / «добавьте два» — число словом тоже число.
  if (!(/\d/.test(text) || NUMBER_WORD_RE.test(text)) || hasDateHint(text.toLowerCase())) return null

  const tomorrow = getMskCalendarDayUtc(now, 1)
  const stats = await getClientStats(client.id, tomorrow.getUTCDay())
  const locationAliases = (client.locationAliases ?? {}) as Record<string, string[]>
  const parsed = await parseClientResponse({
    clientText: text,
    clientName: client.name,
    mealTypeRu: 'приёма пищи',
    locations: client.locations.map((l) => ({
      id: l.id,
      name: l.name,
      aliases: locationAliases[l.id] ?? [],
      mealTypes: l.mealConfigs.map((c) => c.mealType),
    })),
    recentOrders: stats.recentOrders.map((o) => ({
      date: o.date.toISOString().slice(0, 10),
      locationName: o.locationName,
      portions: o.portions,
    })),
  })
  if (parsed.type !== 'numeric' || parsed.items.length === 0) return null
  // Число станет постоянным на все будущие дни — без уверенного разбора и в
  // грубом/срочном тоне не применяем, отдаём менеджеру (spontaneous → inbox).
  if (parsed.confidence < LLM_CONFIDENCE_THRESHOLD) return null
  if (parsed.toneLabel === 'rude' || parsed.toneLabel === 'urgent') return null

  // Каждая позиция → ровно один STICKY-конфиг. Любая неоднозначность → не STICKY.
  const targets: Array<{
    config: ClientMealConfig
    location: ClientWithBotContext['locations'][number]
    portions: number
  }> = []
  for (const item of parsed.items) {
    if (!Number.isInteger(item.portions)) return null
    const location = client.locations.find((l) => l.id === item.locationId)
    if (!location) return null
    const stickyConfigs = location.mealConfigs.filter(
      (c) => c.isActive && c.orderType === 'STICKY' && (!item.mealType || c.mealType === item.mealType),
    )
    if (stickyConfigs.length !== 1) return null
    // «Добавьте 2» / «на 3 меньше» — к текущему постоянному количеству.
    const portions =
      item.mode === 'add' ? (stickyConfigs[0].fixedPortions ?? 0) + item.portions : item.portions
    if (item.mode === 'add' && stickyConfigs[0].fixedPortions == null) return null
    if (portions <= 0 || portions > MAX_STICKY_PORTIONS) return null
    targets.push({ config: stickyConfigs[0], location, portions })
  }

  const actor = await resolveSystemActor()
  if (!actor) {
    console.error('[sticky] нет активного ADMIN_PRO для системных действий — в inbox')
    return null
  }

  await logBotMessage({
    clientId: client.id,
    conversationId: null,
    direction: 'IN',
    text,
    parsedJson: parsed as unknown as Prisma.InputJsonValue,
    llmConfidence: parsed.confidence,
    llmReason: parsed.reason,
    toneLabel: parsed.toneLabel,
  })

  const changes: StickyChange[] = []
  for (const { config, location, portions } of targets) {
    const effectiveFrom = firstEditableDeliveryDate(location, now)
    const oldPortions = config.fixedPortions
    const sameNumber = oldPortions === portions

    // Только сгенерированные по этому конфигу заказы: разовые (MANUAL/BORIS/
    // CLIENT_REQUEST) не перетираем. Проходим и при том же числе — выравниваем
    // заказы, разошедшиеся с конфигом (идемпотентно, «без изменений» не пишется).
    const orders = await prisma.order.findMany({
      where: {
        clientId: client.id,
        locationId: location.id,
        mealType: config.mealType,
        sourceConfigId: config.id,
        source: { in: ['FIXED_AUTO', 'RECURRING_AUTO'] },
        deliveryDate: { gte: effectiveFrom },
        status: { in: ['DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED'] },
        updDocumentLink: { is: null },
      },
      orderBy: { deliveryDate: 'asc' },
      select: { id: true, deliveryDate: true },
    })

    let updated = 0
    const failed: Array<{ orderId: string; reason: string }> = []
    for (const order of orders) {
      const r = await setOrderPortionsForClient(actor, { orderId: order.id, portions, via: 'sticky' })
      if (r.ok) {
        if (r.kind !== 'unchanged') updated++
      } else {
        failed.push({ orderId: order.id, reason: r.skipped ? r.reason : r.error })
      }
    }
    if (failed.length > 0) console.error('[sticky] не все заказы обновлены', { configId: config.id, failed })
    if (sameNumber) {
      changes.push({ locationName: location.name, portions, changed: false, effectiveFrom })
      continue
    }

    // Конфиг — после заказов: генерация следующих дней возьмёт новое число.
    await prisma.clientMealConfig.update({
      where: { id: config.id },
      data: { fixedPortions: portions },
    })

    const firstDay = orders[0]?.deliveryDate ?? firstScheduledDate(config, effectiveFrom)
    await prisma.activityLog.create({
      data: {
        userId: null,
        action: 'STICKY_PORTIONS_CHANGED',
        entityType: 'ClientMealConfig',
        entityId: config.id,
        payload: {
          clientId: client.id,
          locationId: location.id,
          mealType: config.mealType,
          oldPortions,
          newPortions: portions,
          effectiveFrom: effectiveFrom.toISOString().slice(0, 10),
          ordersUpdated: updated,
          ordersFailed: failed,
          auto: true,
        },
      },
    })
    changes.push({ locationName: location.name, portions, changed: true, effectiveFrom: firstDay })
  }

  const anyChanged = changes.some((c) => c.changed)
  const reply = formatStickyReply(changes, targets.length > 1)

  await sendBotMessage(senderChatId, reply)
  await logBotMessage({ clientId: client.id, conversationId: null, direction: 'OUT', text: reply })
  await promoteToActiveByChatId(senderChatId)

  if (anyChanged) {
    const clientNameHtml = escapeHtml(client.name)
    const lines = changes
      .filter((c) => c.changed)
      .map((c) =>
        targets.length > 1
          ? `🔁 ${clientNameHtml} (${escapeHtml(c.locationName)}): теперь ${c.portions} порций с ${formatStickyDate(c.effectiveFrom)}`
          : `🔁 ${clientNameHtml}: теперь ${c.portions} порций с ${formatStickyDate(c.effectiveFrom)}`,
      )
    await notifyProductionChannel(lines.join('\n')).catch((e) => {
      console.error('[sticky] notifyProductionChannel failed:', e)
    })
  }

  return { reply, changed: anyChanged }
}

export function formatStickyReply(changes: StickyChange[], multiLocation: boolean): string {
  if (!changes.some((c) => c.changed)) {
    if (!multiLocation) return `Да, ${changes[0].portions} порций — так и оставляем 👍`
    const rows = changes.map((c) => `${c.locationName} — ${c.portions}`).join(', ')
    return `Да, ${rows} — так и оставляем 👍`
  }
  if (!multiLocation) {
    const c = changes[0]
    return (
      `Принято! Теперь ${c.portions} порций каждый день, начиная с ${formatStickyDate(c.effectiveFrom)}. ` +
      `Если нужно изменить — просто напишите новое число.`
    )
  }
  const rows = changes
    .map((c) =>
      c.changed
        ? `${c.locationName} — ${c.portions} порций с ${formatStickyDate(c.effectiveFrom)}`
        : `${c.locationName} — ${c.portions} порций (без изменений)`,
    )
    .join('\n')
  return `Принято! Теперь каждый день:\n${rows}\nЕсли нужно изменить — просто напишите новое число.`
}
