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
import { extractDateDeterministic, hasDateHint, looksLikeDateRange } from './extract-delivery-date'

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
  /** Клиент просил «с …» на день, приём на который уже закрыт. */
  lateFor?: Date | null
}

const OPEN_START_RE =
  /(^|[^а-яё])(с|со)\s+(\d{1,2}([./]\d{1,2}([./]\d{2,4})?|\s*-?го|\s+[а-яё]+)|понедельник|вторник|сред[ыу]|четверг|пятниц[ыу]|суббот[ыу]|воскресень[яе]|завтра|послезавтра|сегодня)/i
// «по 14.10», «по 14-е», «по 14 октября», «по пятницу», «до конца недели» —
// конец периода. «по 33 порции» — НЕ период (количество на день).
const RANGE_END_RE =
  /(^|[^а-яё])(по|до)\s+(\d{1,2}([./]\d{1,2}|\s*-?(е|го)(?![а-яё])|\s+(янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек))|понедельник|вторник|сред|четверг|пятниц|суббот|воскресень|конца)/i

/**
 * «С 10.10.26», «со среды», «с понедельника», «с завтра» без конца периода →
 * дата начала (UTC-полночь МСК-дня). Период («с 7 по 14»), разовая дата
 * («на пятницу 20») или несколько дат → null.
 */
export function parseOpenEndedStart(text: string, now: Date): Date | null {
  const lower = text.toLowerCase().replace(/ё/g, 'е')
  if (!OPEN_START_RE.test(lower) || RANGE_END_RE.test(lower)) return null
  const date = extractDateDeterministic(text, now)
  if (!date || date === 'ambiguous') return null
  return new Date(`${date}T00:00:00.000Z`)
}

export async function handleStickyMessage(
  client: ClientWithBotContext,
  text: string,
  senderChatId: string,
  now: Date = new Date(),
): Promise<{ reply: string; changed: boolean } | null> {
  // «уберите одну» / «добавьте два» — число словом тоже число.
  if (!(/\d/.test(text) || NUMBER_WORD_RE.test(text))) return null

  // «С 10.10.26 33 порции стабильно» — главный сценарий STICKY (09.10 ХОЛВА:
  // любое сообщение с датой отдавалось менеджеру, бот молчал). Дата «с …» без
  // конца = с какого дня новое постоянное число. Остальное с датой («на
  // пятницу 20», «с 7 по 14») — разовое изменение, не STICKY.
  let requestedFrom: Date | null = null
  if (hasDateHint(text.toLowerCase()) || looksLikeDateRange(text)) {
    const start = parseOpenEndedStart(text, now)
    if (!start) return null
    // Дальше недели: дни до старта ещё не сгенерированы и взяли бы новое число
    // раньше срока — такое отдаём менеджеру.
    if (start.getTime() > getMskCalendarDayUtc(now, 7).getTime()) return null
    requestedFrom = start
  }

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
    const firstEditable = firstEditableDeliveryDate(location, now)
    const effectiveFrom =
      requestedFrom && requestedFrom.getTime() > firstEditable.getTime() ? requestedFrom : firstEditable
    // Клиент просил раньше, чем ещё можно (написал после 16:00 «с завтра»).
    const lateFor = requestedFrom && requestedFrom.getTime() < firstEditable.getTime() ? requestedFrom : null
    const oldPortions = config.fixedPortions
    const sameNumber = oldPortions === portions

    // Все будущие заказы этого питания, кто бы их ни создал: «последнее число»
    // клиента главнее. 09.10 ХАЛВА: заказ на завтра был создан ботом/вручную
    // (source BOT/MANUAL, без sourceConfigId) — фильтр по источнику его
    // пропускал, и новое число на завтра не применялось. Проходим и при том же
    // числе — выравниваем разошедшиеся заказы (идемпотентно).
    const orders = await prisma.order.findMany({
      where: {
        clientId: client.id,
        locationId: location.id,
        mealType: config.mealType,
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
    // То же число, но какой-то заказ стоял иначе и выровнен — это изменение:
    // клиенту «Принято…», производству сигнал.
    if (sameNumber && updated === 0) {
      changes.push({ locationName: location.name, portions, changed: false, effectiveFrom, lateFor })
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
    changes.push({ locationName: location.name, portions, changed: true, effectiveFrom: firstDay, lateFor })
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
    const late = c.lateFor
      ? ` На ${formatStickyDate(c.lateFor)} приём уже закрыт — если нужно, менеджер свяжется.`
      : ''
    return (
      `Принято! Теперь ${c.portions} порций каждый день, начиная с ${formatStickyDate(c.effectiveFrom)}.${late} ` +
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
