import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'

export const dynamic = 'force-dynamic'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 7.14A: Воскресная проверка рынка.
 *
 * Расписание: воскресенье 07:00 UTC = 10:00 МСК. Берём овощи, которые
 * встречались в накладных за последние 7 дней (ACCEPTED или AWAITING_ACCEPT),
 * собираем уникальный список с текущей ценой ингредиента, шлём в групповой чат.
 */
async function handler(_request: Request) {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - SEVEN_DAYS_MS)

  // Овощи, встречавшиеся в накладных за прошлую неделю.
  const vegLines = await prisma.invoiceLine.findMany({
    where: {
      matchedIngredient: { isVegetable: true, isActive: true },
      invoice: {
        receivedAt: { gte: weekAgo, lte: now },
        status: { in: ['ACCEPTED', 'AWAITING_ACCEPT'] },
      },
    },
    include: {
      matchedIngredient: { select: { id: true, name: true, pricePerUnit: true } },
      invoice: { select: { receivedAt: true } },
    },
    orderBy: { invoice: { receivedAt: 'desc' } },
  })

  // Уникальные ингредиенты с текущей ценой.
  const uniqueById = new Map<string, { name: string; price: number }>()
  for (const l of vegLines) {
    if (!l.matchedIngredient) continue
    if (!uniqueById.has(l.matchedIngredient.id)) {
      uniqueById.set(l.matchedIngredient.id, {
        name: l.matchedIngredient.name,
        price: Number(l.matchedIngredient.pricePerUnit),
      })
    }
  }

  if (uniqueById.size === 0) {
    return NextResponse.json({ ok: true, sent: false, reason: 'no_vegetables' })
  }

  const lines: string[] = []
  lines.push('🥬 <b>Воскресная проверка рынка</b>')
  lines.push('')
  lines.push('Цены на овощи с прошлой недели — проверь сегодня на рынке:')
  for (const v of uniqueById.values()) {
    lines.push(`  ${escapeHtml(v.name)} — ${v.price.toLocaleString('ru-RU')} ₽/кг`)
  }

  await notifyGroup(lines.join('\n'), { parseMode: 'HTML' })
  return NextResponse.json({ ok: true, sent: true, count: uniqueById.size })
}

export const GET = withCronHeartbeat('market-check-reminder', handler)
