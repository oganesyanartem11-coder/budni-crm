import { prisma } from '@/lib/db/prisma'
import { getOrderLegalEntitySnapshot } from '@/lib/orders/legal-entity-snapshot'
import { Prisma } from '@prisma/client'
import type { ParseResult } from './parser'
import type { SanityResult } from './sanity-checks'
import type { WeeklyOrderSubmissionStatus, OrderStatus } from '@prisma/client'

/**
 * MEGA-2 weekly-order order-creation / rollback.
 *
 * processWeeklySubmission: персистит WeeklyOrderSubmission, прогоняет sanity-gate,
 * резолвит ACTIVE WEEKLY-конфиг клиента + APPROVED MenuCycle на каждую дату,
 * затем в одной транзакции создаёт по одному CONFIRMED Order на каждый день.
 *
 * cancelWeeklySubmission: откат — CONFIRMED-заказы → DRAFT, всё что уже залочено
 * / в производстве / доставлено остаётся нетронутым.
 *
 * Снапшот ourLegalEntityId/vatRate берём через getOrderLegalEntitySnapshot
 * (тот же источник, что и save-orders.ts — client.defaultOurLegalEntity).
 */

/**
 * Резолвит UTC-полночь календарной даты для @db.Date-колонки deliveryDate.
 *
 * item.date — строка `YYYY-MM-DD` (МСК-календарный день из парсера). @db.Date
 * хранится как UTC-полночь той же календарной даты (см. generate-orders.ts,
 * getMskCalendarDayUtc → Date.UTC(y,m,d)). Парсим компоненты руками и строим
 * Date.UTC, чтобы не зависеть от tz сервера (Bug 7.25).
 */
function deliveryDateFromString(dateStr: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) {
    throw new Error(`invalid item.date format: ${dateStr}`)
  }
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  return new Date(Date.UTC(year, month - 1, day))
}

/**
 * APPROVED MenuCycle, покрывающий дату доставки (validFrom <= date <= validTo).
 * Та же логика, что в boris/tools.ts get_menu_for_date. Возвращает только id —
 * нам достаточно факта существования меню для решения «создавать ли заказ».
 */
async function findMenuCycleForDate(date: Date): Promise<{ id: string } | null> {
  return prisma.menuCycle.findFirst({
    where: {
      status: 'APPROVED',
      validFrom: { lte: date },
      validTo: { gte: date },
    },
    select: { id: true },
  })
}

export async function processWeeklySubmission(params: {
  clientId: string
  source: 'PHOTO' | 'TEXT'
  blobUrl?: string
  rawText?: string
  parsedResult: ParseResult
  sanityResult: SanityResult
  weekStartDate: Date
}): Promise<{
  submissionId: string
  status: WeeklyOrderSubmissionStatus
  createdOrderIds: string[]
}> {
  const { clientId, source, blobUrl, rawText, parsedResult, sanityResult, weekStartDate } = params

  // 1. Персистим заявку (status дефолтит PARSED).
  const submission = await prisma.weeklyOrderSubmission.create({
    data: {
      clientId,
      weekStartDate,
      source,
      blobUrl: blobUrl ?? null,
      rawText: rawText ?? null,
      parsedJson: parsedResult as unknown as Prisma.InputJsonValue,
      confidence: parsedResult.confidence,
      notes: parsedResult.dietaryNotes ?? null,
    },
    select: { id: true },
  })

  try {
    // 2. Sanity-gate провалился → NEEDS_REVIEW, заказов нет.
    if (!sanityResult.ok) {
      await prisma.weeklyOrderSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'NEEDS_REVIEW',
          failureReason: sanityResult.failures.join('; '),
        },
      })
      return { submissionId: submission.id, status: 'NEEDS_REVIEW', createdOrderIds: [] }
    }

    // 3. Активный WEEKLY-конфиг клиента (нужен locationId / mealType / price / packaging).
    const config = await prisma.clientMealConfig.findFirst({
      where: { clientId, orderType: 'WEEKLY', isActive: true },
      include: { location: true },
    })

    if (!config) {
      await prisma.weeklyOrderSubmission.update({
        where: { id: submission.id },
        data: { status: 'NEEDS_REVIEW', failureReason: 'no active WEEKLY config' },
      })
      return { submissionId: submission.id, status: 'NEEDS_REVIEW', createdOrderIds: [] }
    }

    // Резолвим меню для КАЖДОЙ даты ДО создания заказов: если хоть одна дата
    // без меню — NEEDS_REVIEW и ноль заказов (не создаём частично).
    const resolved: Array<{ deliveryDate: Date; portions: number }> = []
    for (const item of parsedResult.items) {
      const deliveryDate = deliveryDateFromString(item.date)
      const menu = await findMenuCycleForDate(deliveryDate)
      if (!menu) {
        await prisma.weeklyOrderSubmission.update({
          where: { id: submission.id },
          data: { status: 'NEEDS_REVIEW', failureReason: `no menu for ${item.date}` },
        })
        return { submissionId: submission.id, status: 'NEEDS_REVIEW', createdOrderIds: [] }
      }
      resolved.push({ deliveryDate, portions: item.portions })
    }

    // Снапшот юрлица/НДС — один на клиента, как в save-orders.ts.
    const snapshot = await getOrderLegalEntitySnapshot(clientId)
    const price = Number(config.pricePerPortion)
    const notes = parsedResult.dietaryNotes ?? null

    // Создаём заказы в транзакции: частичный сбой откатывает всё.
    const createdOrders = await prisma.$transaction(
      resolved.map((r) =>
        prisma.order.create({
          data: {
            clientId,
            locationId: config.locationId,
            mealType: config.mealType,
            deliveryDate: r.deliveryDate,
            portions: r.portions,
            pricePerPortion: price,
            totalPrice: price * r.portions,
            packaging: config.location.packaging,
            status: 'CONFIRMED',
            source: 'WEEKLY_AUTO',
            confirmedAt: new Date(),
            weeklySubmissionId: submission.id,
            sourceConfigId: config.id,
            notes,
            ourLegalEntityId: snapshot.ourLegalEntityId,
            vatRate: snapshot.vatRate,
          },
          select: { id: true },
        })
      )
    )

    const createdOrderIds = createdOrders.map((o) => o.id)

    await prisma.weeklyOrderSubmission.update({
      where: { id: submission.id },
      data: { status: 'AUTO_CONFIRMED' },
    })

    return { submissionId: submission.id, status: 'AUTO_CONFIRMED', createdOrderIds }
  } catch (err) {
    // Транзакция уже откатила заказы при сбое; помечаем заявку FAILED.
    const reason = err instanceof Error ? err.message : String(err)
    await prisma.weeklyOrderSubmission
      .update({
        where: { id: submission.id },
        data: { status: 'FAILED', failureReason: reason },
      })
      .catch(() => {
        /* не маскируем исходную ошибку повторным сбоем апдейта */
      })
    return { submissionId: submission.id, status: 'FAILED', createdOrderIds: [] }
  }
}

export async function cancelWeeklySubmission(params: {
  submissionId: string
  cancelledById: string
}): Promise<{
  cancelled: number
  notCancelled: { orderId: string; status: OrderStatus }[]
}> {
  const { submissionId, cancelledById } = params

  const submission = await prisma.weeklyOrderSubmission.findUnique({
    where: { id: submissionId },
    include: { orders: { select: { id: true, status: true } } },
  })

  if (!submission) {
    throw new Error(`WeeklyOrderSubmission ${submissionId} not found`)
  }

  let cancelled = 0
  const notCancelled: { orderId: string; status: OrderStatus }[] = []

  for (const order of submission.orders) {
    // Откатываем только ещё-не-залоченные CONFIRMED-заказы. Всё что уже
    // LOCKED / IN_PRODUCTION / OUT_FOR_DELIVERY / DELIVERED (и прочее) — не трогаем.
    if (order.status === 'CONFIRMED') {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'DRAFT' },
      })
      cancelled++
    } else {
      notCancelled.push({ orderId: order.id, status: order.status })
    }
  }

  await prisma.weeklyOrderSubmission.update({
    where: { id: submissionId },
    data: { status: 'CANCELLED', cancelledById, cancelledAt: new Date() },
  })

  return { cancelled, notCancelled }
}
