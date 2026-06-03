import { NextResponse } from 'next/server'
import { formatInTimeZone } from 'date-fns-tz'
import { prisma } from '@/lib/db/prisma'
import { notifyAllAdminProDirect, escapeHtml } from '@/lib/telegram/notify'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { getMondayOfWeek, shiftWeek } from '@/lib/utils/week'

export const dynamic = 'force-dynamic'

const CRON_LABEL = 'weekly-missing-alert' // Пт 15:00 МСК
const MSK_TIMEZONE = 'Europe/Moscow'
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Текст алёрта менеджеру. Шаблон VERBATIM (emoji сохранён), подставляем
 * только {ClientName} и диапазон DD.MM по DD.MM.
 */
function buildAlertText(clientName: string, weekStartDate: Date): string {
  // weekStartDate — МСК-полночь Пн; конец недели = +6 дней (Вс).
  const weekEndDate = new Date(weekStartDate.getTime() + 6 * DAY_MS)
  const from = formatInTimeZone(weekStartDate, MSK_TIMEZONE, 'dd.MM')
  const to = formatInTimeZone(weekEndDate, MSK_TIMEZONE, 'dd.MM')
  return `⚠️ ${escapeHtml(clientName)}: нет заявки на след неделю (с ${from} по ${to}). Напомнили в четверг — без ответа. Связаться лично?`
}

/** Активные клиенты с активным WEEKLY meal-config. */
async function findWeeklyClients() {
  return prisma.client.findMany({
    where: {
      isActive: true,
      mealConfigs: { some: { orderType: 'WEEKLY', isActive: true } },
    },
    select: { id: true, name: true, maxChatId: true },
  })
}

/** true, если у клиента уже есть заявка на след. неделю (любой «живой» статус). */
async function hasSubmissionForWeek(clientId: string, weekStartDate: Date): Promise<boolean> {
  const found = await prisma.weeklyOrderSubmission.findFirst({
    where: {
      clientId,
      weekStartDate,
      status: { in: ['PARSED', 'AUTO_CONFIRMED', 'NEEDS_REVIEW'] },
    },
    select: { id: true },
  })
  return !!found
}

export async function handler(request: Request) {
  const url = new URL(request.url)
  const dryRun = url.searchParams.get('dryRun') === 'true'

  const now = new Date()

  if (!dryRun && (await alreadyRanToday(CRON_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  // Заявка — на СЛЕДУЮЩУЮ календарную неделю. getMondayOfWeek(now) = Пн этой
  // недели; shiftWeek(..., 1) = ближайший будущий Пн (МСК-полночь как UTC).
  const weekStartDate = shiftWeek(getMondayOfWeek(now), 1)

  const clients = await findWeeklyClients()

  let alerted = 0
  let skippedHasSubmission = 0
  const errors: Array<{ clientId: string; reason: string }> = []

  for (const client of clients) {
    if (await hasSubmissionForWeek(client.id, weekStartDate)) {
      skippedHasSubmission++
      continue
    }
    if (dryRun) {
      alerted++
      continue
    }
    try {
      const text = buildAlertText(client.name, weekStartDate)
      await notifyAllAdminProDirect(text)
      console.log(`[weekly-missing-alert] alerted manager for client=${client.id}`)
      alerted++
    } catch (err) {
      errors.push({
        clientId: client.id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!dryRun) {
    await markRanToday(CRON_LABEL, {
      alerted,
      skippedHasSubmission,
      errors: errors.length,
    })
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    weekStartDate: weekStartDate.toISOString(),
    alerted,
    skippedHasSubmission,
    errors,
  })
}

export const GET = withCronHeartbeat('weekly-missing-alert', handler)
