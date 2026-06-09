import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { sendBotMessage } from '@/lib/max/send-message'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { getMondayOfWeek, shiftWeek } from '@/lib/utils/week'
import { getActiveMaxChatIdForClient } from '@/lib/bot/max-users'

export const dynamic = 'force-dynamic'

const CRON_LABEL = 'weekly-request-reminder' // Чт 12:00 МСК

// VERBATIM — без emoji, текст менять нельзя.
const WEEKLY_REMINDER_TO_CLIENT = `Здравствуйте! На следующую неделю ещё не получили заявку. Если уже знаете количество — пришлите фото или текст со списком дней и порций. Ждём до воскресенья.

— Будни`

/** Активные клиенты с активным WEEKLY meal-config. */
async function findWeeklyClients() {
  return prisma.client.findMany({
    where: {
      isActive: true,
      mealConfigs: { some: { orderType: 'WEEKLY', isActive: true } },
    },
    select: { id: true, name: true },
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

  let sent = 0
  let skippedHasSubmission = 0
  let skippedNoChat = 0
  const errors: Array<{ clientId: string; reason: string }> = []

  for (const client of clients) {
    if (await hasSubmissionForWeek(client.id, weekStartDate)) {
      skippedHasSubmission++
      continue
    }
    const chatId = await getActiveMaxChatIdForClient(client.id)
    if (!chatId) {
      skippedNoChat++
      continue
    }
    if (dryRun) {
      sent++
      continue
    }
    try {
      // delay:true — естественная задержка 15-30с как у реактивных сообщений
      // бота. На MVP-масштабе (~7 WEEKLY-клиентов) суммарная задержка не
      // упрётся в лимит Vercel-функции, поэтому консистентность с «живой»
      // перепиской важнее.
      await sendBotMessage(chatId, WEEKLY_REMINDER_TO_CLIENT, { delay: true })
      console.log(`[weekly-reminder] sent to client=${client.id}`)
      sent++
    } catch (err) {
      errors.push({
        clientId: client.id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!dryRun) {
    await markRanToday(CRON_LABEL, {
      sent,
      skippedHasSubmission,
      skippedNoChat,
      errors: errors.length,
    })
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    weekStartDate: weekStartDate.toISOString(),
    sent,
    skippedHasSubmission,
    skippedNoChat,
    errors,
  })
}

export const GET = withCronHeartbeat('weekly-request-reminder', handler)
