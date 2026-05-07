'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'

const markDeliveredSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1, 'Список заказов пуст'),
})

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export async function markStopDelivered(
  formData: z.infer<typeof markDeliveredSchema>
): Promise<ActionResult<{ updated: number }>> {
  const user = await requireRole(['ADMIN', 'MANAGER', 'COURIER'])

  const parsed = markDeliveredSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const { orderIds } = parsed.data
  const now = new Date()

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, status: true, delivery: { select: { id: true } } },
  })

  if (orders.length === 0) {
    return { ok: false, error: 'Заказы не найдены' }
  }

  const updates = await prisma.$transaction(async (tx) => {
    let count = 0
    for (const o of orders) {
      if (o.status === 'DELIVERED') continue

      await tx.order.update({
        where: { id: o.id },
        data: { status: 'DELIVERED' },
      })

      if (o.delivery?.id) {
        const existing = await tx.delivery.findUnique({
          where: { id: o.delivery.id },
          select: { courierName: true },
        })

        await tx.delivery.update({
          where: { id: o.delivery.id },
          data: {
            status: 'DELIVERED',
            deliveredAt: now,
            ...(existing?.courierName ? {} : { courierName: user.name }),
          },
        })
      } else {
        await tx.delivery.create({
          data: {
            orderId: o.id,
            type: 'IN_HOUSE',
            status: 'DELIVERED',
            deliveredAt: now,
            courierName: user.name,
          },
        })
      }
      count++
    }
    return count
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'STOP_DELIVERED',
      entityType: 'OrderBatch',
      entityId: orderIds[0],
      payload: { orderIds, count: updates, courierName: user.name },
    },
  })

  revalidatePath('/delivery')
  revalidatePath('/orders')
  return { ok: true, data: { updated: updates } }
}

export async function undoStopDelivered(orderIds: string[]): Promise<ActionResult<{ updated: number }>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return { ok: false, error: 'Список заказов пуст' }
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, status: true, delivery: { select: { id: true } } },
  })

  const updates = await prisma.$transaction(async (tx) => {
    let count = 0
    for (const o of orders) {
      if (o.status !== 'DELIVERED') continue

      await tx.order.update({
        where: { id: o.id },
        data: { status: 'OUT_FOR_DELIVERY' },
      })

      if (o.delivery?.id) {
        await tx.delivery.update({
          where: { id: o.delivery.id },
          data: { status: 'EN_ROUTE', deliveredAt: null },
        })
      }
      count++
    }
    return count
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'STOP_DELIVERY_REVERTED',
      entityType: 'OrderBatch',
      entityId: orderIds[0],
      payload: { orderIds, count: updates },
    },
  })

  revalidatePath('/delivery')
  return { ok: true, data: { updated: updates } }
}
