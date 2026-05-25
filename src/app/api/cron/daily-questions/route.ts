import { NextResponse } from 'next/server'
import { toZonedTime } from 'date-fns-tz'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getNextActiveDayForClient } from '@/lib/db/queries/bot'
import { getDailyQuestionText } from '@/lib/bot/templates'
import { sendBotMessage } from '@/lib/max/send-message'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'

const MSK_TIMEZONE = 'Europe/Moscow'

/** UTC-полночь МСК-календарной даты (МСК today + offset). */
function mskMidnightUtc(now: Date, dayOffset: number): Date {
  const mskNow = toZonedTime(now, MSK_TIMEZONE)
  return new Date(
    Date.UTC(mskNow.getFullYear(), mskNow.getMonth(), mskNow.getDate() + dayOffset, 0, 0, 0, 0)
  )
}

interface ErrorEntry {
  clientName: string
  reason: string
}

interface ResponseBody {
  ok: boolean
  dryRun: boolean
  todayMsk: string
  total_candidates: number
  sent: number
  skipped_not_onboarded: number
  skipped_existing: number
  skipped_no_active_day: number
  errors: ErrorEntry[]
}

async function handler(request: Request) {
  const url = new URL(request.url)
  const dryRun = url.searchParams.get('dryRun') === 'true'

  const now = new Date()
  const todayInMsk = mskMidnightUtc(now, 0)
  const tomorrow = mskMidnightUtc(now, 1)

  // 1. Все активные клиенты с хотя бы одним активным DYNAMIC-конфигом.
  //    maxChatId фильтруем уже внутри цикла — это даёт счётчик skipped_not_onboarded.
  const candidates = await prisma.client.findMany({
    where: {
      isActive: true,
      mealConfigs: { some: { orderType: 'DYNAMIC', isActive: true } },
    },
    select: { id: true, name: true, maxChatId: true },
  })

  const result: ResponseBody = {
    ok: true,
    dryRun,
    todayMsk: todayInMsk.toISOString(),
    total_candidates: candidates.length,
    sent: 0,
    skipped_not_onboarded: 0,
    skipped_existing: 0,
    skipped_no_active_day: 0,
    errors: [],
  }

  for (const client of candidates) {
    try {
      if (!client.maxChatId) {
        result.skipped_not_onboarded++
        console.log(`[daily-questions] skip not-onboarded: ${client.name}`)
        continue
      }

      // 2. Целевой день = первый активный по расписанию от завтра (включительно), макс. 14 дней.
      const next = await getNextActiveDayForClient(client.id, tomorrow)
      if (!next) {
        result.skipped_no_active_day++
        result.errors.push({ clientName: client.name, reason: 'no_active_day_in_14d' })
        console.log(`[daily-questions] no active day in 14d: ${client.name}`)
        continue
      }

      const targetDate = next.date

      // 3. Уже есть BotConversation на эту дату (любой статус)?
      const existing = await prisma.botConversation.findFirst({
        where: { clientId: client.id, deliveryDate: targetDate },
        select: { id: true },
      })
      if (existing) {
        result.skipped_existing++
        console.log(`[daily-questions] skip existing conversation: ${client.name} @ ${targetDate.toISOString()}`)
        continue
      }

      const text = getDailyQuestionText(targetDate, todayInMsk)
      const variantIdx = targetDate.getDate() % 7

      if (dryRun) {
        result.sent++
        console.log(`[daily-questions] DRY: would send to ${client.name} (target=${targetDate.toISOString()}): ${text}`)
        continue
      }

      const conversation = await prisma.botConversation.create({
        data: {
          clientId: client.id,
          deliveryDate: targetDate,
          status: 'PENDING',
          questionVariant: String(variantIdx),
        },
      })

      await sendBotMessage(client.maxChatId, text, { delay: false })

      await prisma.botMessage.create({
        data: {
          clientId: client.id,
          conversationId: conversation.id,
          direction: 'OUT',
          text,
        },
      })

      result.sent++
      console.log(`[daily-questions] sent to ${client.name} (target=${targetDate.toISOString()})`)
    } catch (err) {
      // Race condition по @@unique([clientId, deliveryDate]) — клиент только что сам написал.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        result.skipped_existing++
        console.log(`[daily-questions] P2002 race: ${client.name}`)
        continue
      }
      const reason = err instanceof Error ? err.message : String(err)
      result.errors.push({ clientName: client.name, reason })
      console.error(`[daily-questions] error for ${client.name}:`, reason)
      // 7.12: репорт в in-house tracker (per-client failure, не валит весь cron).
      void import('@/lib/errors/tracker').then((m) =>
        m.trackError({
          error: err,
          extra: { source: 'cron/daily-questions', clientName: client.name },
        })
      )
    }
  }

  return NextResponse.json(result)
}

export const GET = withCronHeartbeat('daily-questions', handler)
