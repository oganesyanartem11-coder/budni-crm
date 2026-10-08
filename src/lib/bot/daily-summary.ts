import { toZonedTime } from 'date-fns-tz'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { sendBotMessage } from '@/lib/max/send-message'
import { getActiveMaxChatIdForClient } from '@/lib/bot/max-users'
import { notifyAllManagersDirect, escapeHtml } from '@/lib/telegram/notify'
import { inboxListButton } from '@/lib/telegram/buttons'
import { formatPortions } from '@/lib/utils/format'
import { SAME_DAY_DYNAMIC_LOCATION, isDeliveryDateAnswered } from '@/lib/bot/daily-questions-core'
import type { MealType } from '@prisma/client'

const MSK_TIMEZONE = 'Europe/Moscow'

/** UTC-полночь МСК-календарной даты (МСК today + offset). */
export function mskMidnightUtc(now: Date, dayOffset: number): Date {
  const m = toZonedTime(now, MSK_TIMEZONE)
  return new Date(Date.UTC(m.getFullYear(), m.getMonth(), m.getDate() + dayOffset, 0, 0, 0, 0))
}

// Узкий cooldown — только защита от Vercel cron retry (~5 мин после сбоя).
// НЕ должен пересекаться с легитимными интервалами между разными cron'ами
// (daily-questions → reminder-1 = 180 мин, reminder-1 → reminder-2 = 90 мин,
// reminder-2 → cutoff-notice = 30 мин — все больше 10).
const REMINDER_COOLDOWN_MINUTES = 10

/**
 * Молчащие PENDING-conv созданные сегодня (созданные cron'ом 11:00 МСК).
 * «Молчит» = ни одного BotMessage(direction=IN) на этой conv.
 *
 * ВНИМАНИЕ: эта функция НЕ исключает same-day-клиентов и passed-cutoff —
 * это намеренно делается у потребителей: sendRemindersToSilentClients (7.51 F-B)
 * и cutoff-notice/route.ts фильтруют same-day сами. Не добавляй рассылку поверх
 * этой выборки без такого фильтра, иначе повторишь баг 7.51 (same-day получали
 * «до 16:00» после своего утреннего cut-off).
 */
export async function findSilentPendingConvsCreatedToday(now: Date) {
  const todayUtc = mskMidnightUtc(now, 0)
  return prisma.botConversation.findMany({
    where: {
      status: 'PENDING',
      createdAt: { gte: todayUtc },
      messages: { none: { direction: 'IN' } },
    },
    include: {
      client: { select: { id: true, name: true } },
    },
  })
}

/**
 * True если за последние REMINDER_COOLDOWN_MINUTES на conv уже был OUT.
 * Защита от двойного срабатывания cron'а.
 */
async function recentlyMessagedClient(convId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - REMINDER_COOLDOWN_MINUTES * 60_000)
  const recent = await prisma.botMessage.findFirst({
    where: { conversationId: convId, direction: 'OUT', createdAt: { gte: since } },
    select: { id: true },
  })
  return !!recent
}

export interface SendOutcome {
  sent: number
  skipped: number
  errors: Array<{ clientName: string; reason: string }>
}

/** Рассылает текст напоминания всем молчащим клиентам сегодня. Per-conv idempotent. */
export async function sendRemindersToSilentClients(
  textFor: (deliveryDate: Date, now: Date) => string,
  now: Date = new Date()
): Promise<SendOutcome> {
  const convs = await findSilentPendingConvsCreatedToday(now)
  const outcome: SendOutcome = { sent: 0, skipped: 0, errors: [] }

  // 7.51 / F-B: исключаем same-day-клиентов из напоминаний. У них утренний
  // персональный cut-off (напр. 08:40), который к 14:00/15:30 уже прошёл —
  // «до 16:00» им неуместно. Тот же фильтр, что в cutoff-notice/route.ts.
  // Это покрывает и passed-cutoff: same-day cut-off всегда в первой половине
  // дня, а reminder-1/2 идут в 14:00/15:30 (позже). NEXT_DAY-клиенты держат
  // глобальный 16:00 (ещё не наступил в 14:00/15:30) — их не трогаем.
  const clientIds = [...new Set(convs.map((c) => c.clientId))]
  const sameDayClients = clientIds.length
    ? await prisma.client.findMany({
        // Только АКТИВНАЯ same-day точка с DYNAMIC-питанием (тот же предикат, что
        // выбор кандидатов daily-questions): деактивированная same-day точка не
        // делает клиента same-day.
        where: { id: { in: clientIds }, locations: { some: SAME_DAY_DYNAMIC_LOCATION } },
        select: { id: true },
      })
    : []
  const sameDayClientIds = new Set(sameDayClients.map((c) => c.id))

  for (const conv of convs) {
    try {
      if (sameDayClientIds.has(conv.clientId)) {
        // same-day — их cut-off уже прошёл, пропускаем (см. коммент выше).
        outcome.skipped++
        continue
      }
      const chatId = await getActiveMaxChatIdForClient(conv.client.id)
      if (!chatId) {
        outcome.skipped++
        continue
      }
      if (await recentlyMessagedClient(conv.id, now)) {
        outcome.skipped++
        continue
      }
      // Число на дату уже поставил менеджер/Борис после вопроса — не дёргаем.
      if (await isDeliveryDateAnswered(conv.clientId, conv.deliveryDate)) {
        outcome.skipped++
        continue
      }

      const text = textFor(conv.deliveryDate, now)
      // Cron-рассылка (reminder-1/2): получателей может быть много, естественная
      // задержка из sendBotMessage упёрлась бы в timeout Vercel-функции.
      await sendBotMessage(chatId, text, { delay: false })
      await prisma.botMessage.create({
        data: {
          clientId: conv.clientId,
          conversationId: conv.id,
          direction: 'OUT',
          text,
        },
      })
      outcome.sent++
    } catch (err) {
      outcome.errors.push({
        clientName: conv.client.name,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return outcome
}

const MEAL_ORDER: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']
const MEAL_LABEL: Record<MealType, string> = { BREAKFAST: 'завтрак', LUNCH: 'обед', DINNER: 'ужин' }

export interface SummaryOrder {
  portions: number
  status: string
  mealType: MealType
  location: { id: string; name: string }
}

/**
 * Разбивка порций клиента: по приёмам пищи и (если точек несколько) по точкам.
 * CANCELLED не считаем. Один приём на одной точке → «75 порций».
 *   «завтрак 45 · обед 75 · ужин 45»
 *   «Офис: обед 30; Склад: обед 20 · ужин 10»
 */
export function formatOrdersBreakdown(orders: SummaryOrder[]): string {
  const live = orders.filter((o) => o.status !== 'CANCELLED')
  if (live.length === 0) return formatPortions(0)
  const byLoc = new Map<string, { name: string; meals: Map<MealType, number> }>()
  for (const o of live) {
    const loc = byLoc.get(o.location.id) ?? { name: o.location.name, meals: new Map() }
    loc.meals.set(o.mealType, (loc.meals.get(o.mealType) ?? 0) + o.portions)
    byLoc.set(o.location.id, loc)
  }
  const fmtMeals = (meals: Map<MealType, number>) =>
    MEAL_ORDER.filter((m) => meals.has(m))
      .map((m) => `${MEAL_LABEL[m]} ${meals.get(m)}`)
      .join(' · ')
  const locs = [...byLoc.values()]
  if (locs.length === 1) {
    const meals = locs[0].meals
    if (meals.size === 1) return formatPortions([...meals.values()][0])
    return fmtMeals(meals)
  }
  return locs.map((l) => `${escapeHtml(l.name)}: ${fmtMeals(l.meals)}`).join('; ')
}

function fmtDdMm(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Строит текст сводки. Возвращает null если за сегодня нет ни одной отслеживаемой
 * conv (значит cron 11:00 ничего не нашёл — рассылать managers нечего).
 *
 * Группы:
 *   - «Принято»       : status=CONFIRMED — клиент ответил числом; разбивка по
 *                       приёмам пищи / точкам, отменённые заказы не считаются
 *   - «Не ответили»   : status=PENDING без IN-сообщений (молчат)
 *   - «У менеджера»   : status=AWAITING_MANAGER — клиент ответил, но разбор у
 *                       менеджера (раньше пропадали из «X из Y»)
 * PENDING с IN (тех. странный кейс) исключены, чтобы не путать менеджера.
 * Если среди conv разные даты доставки (same-day «сегодня» + обычные «завтра»),
 * к строке клиента добавляется дата «(DD.MM)».
 * Текст уходит в Telegram с parse_mode=HTML — имена экранируются.
 */
export async function buildSummaryText(title: string, now: Date = new Date()): Promise<string | null> {
  const todayUtc = mskMidnightUtc(now, 0)

  const convs = await prisma.botConversation.findMany({
    where: { createdAt: { gte: todayUtc } },
    include: {
      client: { select: { id: true, name: true } },
      orders: {
        select: {
          portions: true,
          status: true,
          mealType: true,
          location: { select: { id: true, name: true } },
        },
      },
      messages: { where: { direction: 'IN' }, select: { id: true }, take: 1 },
    },
  })

  const confirmed = convs.filter((c) => c.status === 'CONFIRMED')
  const silent = convs.filter((c) => c.status === 'PENDING' && c.messages.length === 0)
  const withManager = convs.filter((c) => c.status === 'AWAITING_MANAGER')
  const shown = [...confirmed, ...silent, ...withManager]
  const total = shown.length

  if (total === 0) return null

  const mixedDates = new Set(shown.map((c) => c.deliveryDate.getTime())).size > 1
  const name = (c: (typeof convs)[number]) =>
    escapeHtml(c.client.name) + (mixedDates ? ` (${fmtDdMm(c.deliveryDate)})` : '')

  const lines: string[] = [escapeHtml(title), '']
  lines.push(`Принято: ${confirmed.length} из ${total}`)
  for (const c of confirmed) {
    lines.push(`• ${name(c)} — ${formatOrdersBreakdown(c.orders)}`)
  }
  lines.push('')
  lines.push(`Не ответили: ${silent.length}`)
  for (const c of silent) {
    lines.push(`• ${name(c)}`)
  }
  if (withManager.length > 0) {
    lines.push('')
    lines.push(`У менеджера: ${withManager.length}`)
    for (const c of withManager) {
      lines.push(`• ${name(c)}`)
    }
  }

  return lines.join('\n')
}

export interface SummaryOutcome {
  sentToManagers: number
  errors: Array<{ managerId: string; reason: string }>
}

/**
 * Шлёт текст сводки всем активным ADMIN/MANAGER в Telegram.
 *
 * 5.8c: переехало с MAX на Telegram. Менеджеры без Telegram-онбординга
 * пропускаются (раньше падало в MAX по User.maxChatId — теперь MAX для
 * управленческих каналов не используется, см. SPRINT_5.8c).
 *
 * Поле `errors` оставлено для совместимости с роутами reminder-1/2:
 * по-агрегации failed/skipped Telegram-API возвращает счётчики, а не
 * per-manager ошибки, поэтому массив всегда пуст. sentToManagers
 * соответствует sentTo из notifyAllManagersDirect.
 */
export async function sendSummaryToManagers(text: string): Promise<SummaryOutcome> {
  const result = await notifyAllManagersDirect(text, { replyMarkup: inboxListButton() })
  return { sentToManagers: result.sentTo, errors: [] }
}

/**
 * Idempotency-гард для cron'а на сутки в МСК-календаре.
 * Сохраняет факт запуска в ActivityLog с action='BOT_CRON_SUMMARY'.
 * Если уже было сегодня (по МСК) — возвращает true (skip), иначе false (run).
 */
export async function alreadyRanToday(label: string, now: Date = new Date()): Promise<boolean> {
  const todayUtc = mskMidnightUtc(now, 0)
  const log = await prisma.activityLog.findFirst({
    where: {
      action: 'BOT_CRON_SUMMARY',
      entityId: label,
      createdAt: { gte: todayUtc },
    },
    select: { id: true },
  })
  return !!log
}

/** Помечает запуск cron'а в ActivityLog. Защита от двойного срабатывания. */
export async function markRanToday(label: string, payload: Prisma.InputJsonValue): Promise<void> {
  await prisma.activityLog
    .create({
      data: {
        userId: null,
        userRole: 'ADMIN',
        action: 'BOT_CRON_SUMMARY',
        entityType: 'cron',
        entityId: label,
        payload,
      },
    })
    .catch(() => {
      /* лог не должен ронять cron */
    })
}

/**
 * Сумма счётчика `payload.anomalies` по указанным cron-меткам за СЕГОДНЯ (МСК).
 * На каждую метку берём ПОСЛЕДНЮЮ запись дня — принудительные повторы
 * (?force=true) плодят строки, иначе счёт бы двоился. Ошибка чтения → 0
 * (статистика не должна ронять отчёт).
 *
 * Нужна дневной сводке Бориса-Директа: если утром/днём уже улетали алёрты,
 * вечерняя сводка ссылается на них, а не пишет «аномалий нет».
 */
export async function getTodayCronAnomalyCount(
  labels: string[],
  now: Date = new Date()
): Promise<number> {
  const todayUtc = mskMidnightUtc(now, 0)
  let total = 0
  for (const label of labels) {
    try {
      const latest = await prisma.activityLog.findFirst({
        where: { action: 'BOT_CRON_SUMMARY', entityId: label, createdAt: { gte: todayUtc } },
        orderBy: { createdAt: 'desc' },
        select: { payload: true },
      })
      const payload = (latest?.payload ?? null) as { anomalies?: unknown } | null
      const n = typeof payload?.anomalies === 'number' ? payload.anomalies : 0
      if (Number.isFinite(n) && n > 0) total += n
    } catch {
      /* чтение статистики не должно ронять отчёт */
    }
  }
  return total
}
