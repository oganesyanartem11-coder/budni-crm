import { NextResponse } from 'next/server'
import { generateFixedOrdersForDate } from '@/lib/orders/generate-orders'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'

/**
 * Cron-route для Vercel Cron Jobs.
 * Защищён CRON_SECRET в Authorization header (HOF withCronHeartbeat).
 * Запускается ежедневно в 03:00 UTC (06:00 MSK), генерирует FIXED-заказы на завтра.
 */
async function handler(_request: Request) {
  // Целевая дата — завтра
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)

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
