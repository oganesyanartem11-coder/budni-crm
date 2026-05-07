import { prisma } from '@/lib/db/prisma'

export interface LockStats {
  targetDate: string
  candidatesTotal: number
  locked: number
  errors: Array<{ orderId: string; error: string }>
}

/**
 * Переводит все CONFIRMED-заказы на указанную дату в LOCKED.
 * Ставит lockedAt = текущее время.
 *
 * Идемпотентно: уже LOCKED заказы не трогает.
 * Не трогает PENDING_CONFIRMATION (они должны были быть подтверждены до 16:00,
 * но если менеджер пропустил cut-off — это не повод их лочить, надо чтобы он
 * сначала их обработал).
 */
export async function lockOrdersForDate(targetDate: Date): Promise<LockStats> {
  const date = new Date(targetDate)
  date.setHours(0, 0, 0, 0)
  const dayEnd = new Date(date)
  dayEnd.setHours(23, 59, 59, 999)

  const stats: LockStats = {
    targetDate: date.toISOString(),
    candidatesTotal: 0,
    locked: 0,
    errors: [],
  }

  const candidates = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: date, lte: dayEnd },
      status: 'CONFIRMED',
    },
    select: { id: true },
  })

  stats.candidatesTotal = candidates.length

  if (candidates.length === 0) return stats

  try {
    const result = await prisma.order.updateMany({
      where: {
        id: { in: candidates.map((c) => c.id) },
        status: 'CONFIRMED',
      },
      data: {
        status: 'LOCKED',
        lockedAt: new Date(),
      },
    })
    stats.locked = result.count
  } catch (err) {
    stats.errors.push({
      orderId: 'batch',
      error: err instanceof Error ? err.message : String(err),
    })
  }

  await prisma.activityLog.create({
    data: {
      userId: null,
      userRole: 'ADMIN',
      action: 'ORDERS_LOCKED',
      entityType: 'OrderBatch',
      entityId: date.toISOString().slice(0, 10),
      payload: {
        targetDate: stats.targetDate,
        candidatesTotal: stats.candidatesTotal,
        locked: stats.locked,
        errors: stats.errors.length,
      },
    },
  }).catch(() => {})

  return stats
}
