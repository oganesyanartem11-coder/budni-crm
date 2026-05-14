'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { parseWindowToDate } from '@/lib/utils/msk-window'
import { notifyAllManagersDirect, escapeHtml } from '@/lib/telegram/notify'
import { orderDetailButton } from '@/lib/telegram/buttons'
import { assertOrderUpdatedAt, OptimisticLockError } from '@/lib/db/optimistic-lock'
import {
  DELIVERY_ISSUE_REASONS,
  DELIVERY_ISSUE_REASON_LABELS,
  type DeliveryIssueReason,
} from '@/lib/constants/delivery'
import { formatDeliveryWindow } from '@/lib/utils/format'

const markDeliveredSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1, 'Список заказов пуст'),
  // 6.8b: optimistic lock — map orderId → updatedAt ISO. Если не передан или
  // нет ключа для какого-то orderId — для этого id проверка скипается.
  expectedUpdatedAts: z.record(z.string(), z.string()).optional(),
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

  const { orderIds, expectedUpdatedAts } = parsed.data
  const now = new Date()

  // 6.8b: optimistic lock — проверяем каждый Order до начала транзакции.
  // Если хоть один заказ изменён другим юзером (менеджер успел отменить
  // пока курьер ехал) — отказываем целиком, чтобы не доставить отменённое.
  if (expectedUpdatedAts) {
    try {
      for (const id of orderIds) {
        await assertOrderUpdatedAt(id, expectedUpdatedAts[id])
      }
    } catch (e) {
      if (e instanceof OptimisticLockError) return { ok: false, error: e.message }
      throw e
    }
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true, status: true, deliveryDate: true,
      delivery: { select: { id: true } },
      location: { select: { deliveryWindowFrom: true } },
    },
  })

  if (orders.length === 0) {
    return { ok: false, error: 'Заказы не найдены' }
  }

  // Защита: курьер не должен отмечать «Доставлено» раньше начала окна доставки.
  // Берём минимум из windowFrom по заказам остановки (одна точка → один from).
  // ADMIN/MANAGER пропускают проверку — для теста и аварийных правок.
  if (user.role === 'COURIER') {
    for (const o of orders) {
      const windowStart = parseWindowToDate(o.location.deliveryWindowFrom, o.deliveryDate)
      if (windowStart && now < windowStart) {
        return {
          ok: false,
          error: `Окно доставки ещё не началось (с ${o.location.deliveryWindowFrom})`,
        }
      }
    }
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

const reportIssueSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1, 'Список заказов пуст'),
  reason: z.enum(DELIVERY_ISSUE_REASONS),
  comment: z.string().trim().max(200).optional().nullable(),
})

/**
 * Курьер сообщает «не смог доставить» по остановке (или менеджер от его имени).
 * Статус Order НЕ меняется — менеджер сам решает (звонок, перенос, отмена).
 * Запись идёт во все Delivery остановки (одна остановка = N order'ов).
 * Push в личку всем активным MANAGER. Если push упал — save не блокируется.
 */
export async function reportDeliveryIssue(
  formData: z.infer<typeof reportIssueSchema>
): Promise<ActionResult<{ updated: number }>> {
  const user = await requireRole(['ADMIN', 'MANAGER', 'COURIER'])

  const parsed = reportIssueSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const { orderIds, reason, comment } = parsed.data
  const now = new Date()

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      delivery: { select: { id: true } },
      client: { select: { name: true } },
      location: {
        select: {
          name: true,
          deliveryWindowFrom: true,
          deliveryWindowTo: true,
        },
      },
    },
  })

  if (orders.length === 0) {
    return { ok: false, error: 'Заказы не найдены' }
  }

  // Записываем issue во все Delivery остановки (создаём Delivery если не было).
  let updated = 0
  await prisma.$transaction(async (tx) => {
    for (const o of orders) {
      if (o.delivery?.id) {
        await tx.delivery.update({
          where: { id: o.delivery.id },
          data: {
            issueReportedAt: now,
            issueReason: reason,
            issueComment: comment?.trim() || null,
            issueReportedById: user.id,
          },
        })
      } else {
        await tx.delivery.create({
          data: {
            orderId: o.id,
            type: 'IN_HOUSE',
            status: 'ASSIGNED',
            issueReportedAt: now,
            issueReason: reason,
            issueComment: comment?.trim() || null,
            issueReportedById: user.id,
          },
        })
      }
      updated++
    }
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'COURIER_REPORTED_DELIVERY_ISSUE',
      entityType: 'OrderBatch',
      entityId: orderIds[0],
      payload: { orderIds, reason, comment: comment ?? null, courierId: user.id },
    },
  })

  // Push в личку всем MANAGER+ADMIN c Telegram. Метаданные берём с первого
  // заказа остановки — все принадлежат одной location и client.
  const first = orders[0]
  const windowStr = formatDeliveryWindow(first.location.deliveryWindowFrom, first.location.deliveryWindowTo)
  const lines: string[] = [
    `🚨 <b>Проблема с доставкой</b>`,
    ``,
    `${escapeHtml(first.client.name)} · ${escapeHtml(first.location.name)}`,
  ]
  if (windowStr !== '—') lines.push(`Окно: ${windowStr}`)
  lines.push(``)
  lines.push(`Причина: ${DELIVERY_ISSUE_REASON_LABELS[reason as DeliveryIssueReason]}`)
  if (comment?.trim()) lines.push(`Курьер: «${escapeHtml(comment.trim())}»`)
  lines.push(``)
  lines.push(`Сообщил: ${escapeHtml(user.name)}`)

  await notifyAllManagersDirect(lines.join('\n'), {
    parseMode: 'HTML',
    replyMarkup: orderDetailButton(first.id),
  })

  revalidatePath('/delivery')
  revalidatePath('/orders')
  revalidatePath(`/orders/${first.id}`)
  return { ok: true, data: { updated } }
}

const clearIssueSchema = z.object({
  deliveryId: z.string().min(1),
})

/**
 * Менеджер снимает метку «проблема» с одной Delivery. Используется на
 * /orders/[id] — после звонка клиенту, переноса или ручного разруливания.
 * Не удаляет ActivityLog (исторический след сохраняется).
 */
export async function clearDeliveryIssue(
  formData: z.infer<typeof clearIssueSchema>
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = clearIssueSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const delivery = await prisma.delivery.findUnique({
    where: { id: parsed.data.deliveryId },
    select: { id: true, orderId: true, issueReportedAt: true, issueReason: true },
  })
  if (!delivery) return { ok: false, error: 'Доставка не найдена' }
  if (!delivery.issueReportedAt) return { ok: false, error: 'Метка уже снята' }

  await prisma.delivery.update({
    where: { id: delivery.id },
    data: {
      issueReportedAt: null,
      issueReason: null,
      issueComment: null,
      issueReportedById: null,
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'MANAGER_CLEARED_DELIVERY_ISSUE',
      entityType: 'Order',
      entityId: delivery.orderId,
      payload: { deliveryId: delivery.id, clearedReason: delivery.issueReason },
    },
  })

  revalidatePath('/delivery')
  revalidatePath('/orders')
  revalidatePath(`/orders/${delivery.orderId}`)
  return { ok: true, data: undefined }
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
