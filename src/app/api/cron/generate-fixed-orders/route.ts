import { NextResponse } from 'next/server'
import { generateFixedOrdersForDate } from '@/lib/orders/generate-orders'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'

export const dynamic = 'force-dynamic'

/**
 * Cron-route для Vercel Cron Jobs.
 * Защищён CRON_SECRET в Authorization header (HOF withCronHeartbeat).
 * Запускается ежедневно в 03:00 UTC (06:00 MSK), генерирует FIXED-заказы на завтра.
 */
async function handler(_request: Request) {
  // Целевая дата — завтра по календарю МСК (UTC-полночь этого дня).
  // 7.39: было наивное new Date()+setDate(+1), которое около 00:00 UTC (03:00 МСК)
  // давало неверный день. getMskCalendarDayUtc(now, 1) корректно учитывает зону.
  const tomorrow = getMskCalendarDayUtc(new Date(), 1)

  try {
    const stats = await generateFixedOrdersForDate(tomorrow, {
      triggeredByUserId: null, // null = запуск от системы
    })

    return NextResponse.json({ ok: true, stats })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    )
  }
}

export const GET = withCronHeartbeat('generate-fixed-orders', handler)
