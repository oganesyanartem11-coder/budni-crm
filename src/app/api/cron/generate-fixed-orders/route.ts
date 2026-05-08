import { NextResponse } from 'next/server'
import { generateFixedOrdersForDate } from '@/lib/orders/generate-orders'

export const dynamic = 'force-dynamic'

/**
 * Cron-route для Vercel Cron Jobs.
 * Защищён CRON_SECRET в Authorization header.
 * Запускается ежедневно в 03:00 UTC (06:00 MSK), генерирует FIXED-заказы на завтра.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const expectedSecret = process.env.CRON_SECRET

  if (!expectedSecret) {
    return NextResponse.json(
      { ok: false, error: 'CRON_SECRET not configured' },
      { status: 500 }
    )
  }

  if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized' },
      { status: 401 }
    )
  }

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
