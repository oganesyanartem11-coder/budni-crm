import { NextResponse } from 'next/server'
import { lockOrdersForDate } from '@/lib/orders/lock-orders'

export const dynamic = 'force-dynamic'

/**
 * Cron-route для Vercel Cron Jobs. Запускается ежедневно в 15:00 UTC (18:00 MSK).
 * Лочит все CONFIRMED-заказы на завтра.
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

  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)

  try {
    const stats = await lockOrdersForDate(tomorrow)
    return NextResponse.json({ ok: true, stats })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
