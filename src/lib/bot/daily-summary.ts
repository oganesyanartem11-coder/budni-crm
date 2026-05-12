import { toZonedTime } from 'date-fns-tz'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { sendBotMessage } from '@/lib/max/send-message'
import { notifyAllManagersDirect } from '@/lib/telegram/notify'
import { inboxListButton } from '@/lib/telegram/buttons'
import { formatPortions } from '@/lib/utils/format'

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
      client: { select: { id: true, name: true, maxChatId: true } },
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
  textFor: (deliveryDate: Date) => string,
  now: Date = new Date()
): Promise<SendOutcome> {
  const convs = await findSilentPendingConvsCreatedToday(now)
  const outcome: SendOutcome = { sent: 0, skipped: 0, errors: [] }

  for (const conv of convs) {
    try {
      if (!conv.client.maxChatId) {
        outcome.skipped++
        continue
      }
      if (await recentlyMessagedClient(conv.id, now)) {
        outcome.skipped++
        continue
      }

      const text = textFor(conv.deliveryDate)
      await sendBotMessage(conv.client.maxChatId, text)
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

/**
 * Строит текст сводки. Возвращает null если за сегодня нет ни одной отслеживаемой
 * conv (значит cron 11:00 ничего не нашёл — рассылать managers нечего).
 *
 * Группы:
 *   - «Принято»  : status=CONFIRMED — клиент ответил числом (кейс A/B/C)
 *   - «Не ответили» : status=PENDING без IN-сообщений (молчат)
 * AWAITING_MANAGER исключены (manager уже получил срочный push).
 * PENDING с IN (тех. странный кейс — клиент написал, но статус не сменился)
 * также исключены, чтобы не путать менеджера.
 */
export async function buildSummaryText(title: string, now: Date = new Date()): Promise<string | null> {
  const todayUtc = mskMidnightUtc(now, 0)

  const convs = await prisma.botConversation.findMany({
    where: { createdAt: { gte: todayUtc } },
    include: {
      client: { select: { id: true, name: true } },
      orders: { select: { portions: true } },
      messages: { where: { direction: 'IN' }, select: { id: true }, take: 1 },
    },
  })

  const confirmed = convs.filter((c) => c.status === 'CONFIRMED')
  const silent = convs.filter((c) => c.status === 'PENDING' && c.messages.length === 0)
  const total = confirmed.length + silent.length

  if (total === 0) return null

  const lines: string[] = [title, '']
  lines.push(`Принято: ${confirmed.length} из ${total}`)
  for (const c of confirmed) {
    const totalPortions = c.orders.reduce((s, o) => s + o.portions, 0)
    lines.push(`• ${c.client.name} — ${formatPortions(totalPortions)}`)
  }
  lines.push('')
  lines.push(`Не ответили: ${silent.length}`)
  for (const c of silent) {
    lines.push(`• ${c.client.name}`)
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
