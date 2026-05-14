import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { notifyAllManagersDirect, escapeHtml } from '@/lib/telegram/notify'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ACTION = 'UNPRICED_INGREDIENTS_DIGEST_SENT'
// Окно поиска — последние 2 часа. Идемпотентность — за последние 90 минут
// (если cron упал и перезапустился через час, повторно не отправляем).
const LOOKBACK_MS = 2 * 60 * 60 * 1000
const IDEMPOTENCY_WINDOW_MS = 90 * 60 * 1000

/**
 * 6.7: дайджест новых ингредиентов без цены. Шеф добавляет ингредиент
 * (pricePerUnit=0), MANAGER должен проставить реальную цену.
 *
 * Не зарегистрирован в vercel.json — Vercel Hobby не разрешает cron'ы
 * чаще раза в день (см. hotfix f58fde3). Запускать вручную или внешним
 * cron-сервисом (curl с Bearer CRON_SECRET). Файл готов к включению
 * после апгрейда на Pro.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const expectedSecret = process.env.CRON_SECRET
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()

  // Идемпотентность: уже слали в последние 90 мин — пропускаем.
  const recent = await prisma.activityLog.findFirst({
    where: {
      action: ACTION,
      createdAt: { gte: new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS) },
    },
    select: { id: true },
  })
  if (recent) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_recently' })
  }

  // Ищем активные ингредиенты без цены, созданные за последние 2 часа.
  const since = new Date(now.getTime() - LOOKBACK_MS)
  const fresh = await prisma.ingredient.findMany({
    where: {
      isActive: true,
      pricePerUnit: 0,
      createdAt: { gte: since },
    },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  })

  if (fresh.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, reason: 'nothing_new' })
  }

  const names = fresh.map((i) => escapeHtml(i.name)).join(', ')
  const text =
    `🏷️ <b>Новые ингредиенты без цены</b>\n\n` +
    `Шеф добавил ${fresh.length}: ${names}\n\n` +
    `Откройте <a href="${process.env.NEXT_PUBLIC_APP_URL ?? ''}/ingredients">/ingredients</a> ` +
    `и проставьте цены.`

  const result = await notifyAllManagersDirect(text, { parseMode: 'HTML' })

  await prisma.activityLog.create({
    data: {
      userId: null,
      userRole: null,
      action: ACTION,
      entityType: 'System',
      entityId: now.toISOString().slice(0, 10),
      payload: {
        ingredientIds: fresh.map((i) => i.id),
        count: fresh.length,
        sentTo: result.sentTo,
        skippedNoTelegram: result.skippedNoTelegram,
        failed: result.failed,
      },
    },
  })

  return NextResponse.json({
    ok: true,
    sent: fresh.length,
    sentTo: result.sentTo,
    skippedNoTelegram: result.skippedNoTelegram,
    failed: result.failed,
  })
}
