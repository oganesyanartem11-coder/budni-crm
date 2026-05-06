import { PrismaClient, type OrderStatus, type PackagingType, type MealType } from '@prisma/client'

function isWeekday(d: Date): boolean {
  const day = d.getDay()
  return day !== 0 && day !== 6
}

function dateOnly(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function jitter(base: number, variance: number): number {
  const min = Math.max(1, base - variance)
  const max = base + variance
  return Math.floor(min + Math.random() * (max - min + 1))
}

/**
 * Очищает заказы и доставки за последние 30 дней.
 * Вынесено отдельной функцией, чтобы вызывать ДО seedClients —
 * иначе FK constraint на Order.locationId блокирует удаление ClientLocation.
 */
export async function clearRecentOrders(prisma: PrismaClient): Promise<void> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  await prisma.delivery.deleteMany({
    where: { order: { createdAt: { gte: cutoff } } },
  })
  await prisma.order.deleteMany({
    where: { createdAt: { gte: cutoff } },
  })
}

export async function seedOrders(prisma: PrismaClient): Promise<number> {
  // Очистка перенесена в clearRecentOrders, вызывается из index.ts перед seedClients

  const configs = await prisma.clientMealConfig.findMany({
    where: { isActive: true },
    include: { client: true, location: true },
  })

  let orderCount = 0
  const today = dateOnly(new Date())

  for (let offset = -14; offset <= 1; offset++) {
    const deliveryDate = new Date(today)
    deliveryDate.setDate(today.getDate() + offset)

    for (const cfg of configs) {
      if (!cfg.locationId) continue

      const dow = deliveryDate.getDay()
      const isWk = dow !== 0 && dow !== 6
      let shouldSkip = false
      if (cfg.scheduleType === 'WEEKDAYS' && !isWk) shouldSkip = true
      if (cfg.scheduleType === 'WEEKENDS' && isWk) shouldSkip = true

      if (shouldSkip) continue

      let portions: number
      if (cfg.orderType === 'FIXED') {
        portions = cfg.fixedPortions ?? 10
      } else {
        portions = jitter(20, 8)
      }

      let status: OrderStatus
      let confirmedAt: Date | null = null
      let lockedAt: Date | null = null

      if (offset < -1) {
        status = 'DELIVERED'
        confirmedAt = new Date(deliveryDate)
        confirmedAt.setDate(confirmedAt.getDate() - 1)
        confirmedAt.setHours(15, 30)
        lockedAt = new Date(confirmedAt)
        lockedAt.setHours(18, 0)
      } else if (offset === -1) {
        status = Math.random() > 0.05 ? 'DELIVERED' : 'CANCELLED'
        confirmedAt = new Date(deliveryDate)
        confirmedAt.setDate(confirmedAt.getDate() - 1)
        confirmedAt.setHours(15, 30)
        lockedAt = new Date(confirmedAt)
        lockedAt.setHours(18, 0)
      } else if (offset === 0) {
        const r = Math.random()
        if (r < 0.4) status = 'DELIVERED'
        else if (r < 0.7) status = 'OUT_FOR_DELIVERY'
        else status = 'IN_PRODUCTION'
        confirmedAt = new Date(deliveryDate)
        confirmedAt.setDate(confirmedAt.getDate() - 1)
        confirmedAt.setHours(15, 30)
        lockedAt = new Date(confirmedAt)
        lockedAt.setHours(18, 0)
      } else {
        if (cfg.orderType === 'FIXED') {
          status = 'CONFIRMED'
          confirmedAt = new Date()
        } else {
          status = Math.random() > 0.3 ? 'CONFIRMED' : 'PENDING_CONFIRMATION'
          if (status === 'CONFIRMED') confirmedAt = new Date()
        }
      }

      const pricePerPortion = Number(cfg.pricePerPortion)
      const totalPrice = pricePerPortion * portions

      const order = await prisma.order.create({
        data: {
          clientId: cfg.clientId,
          locationId: cfg.locationId,
          mealType: cfg.mealType,
          deliveryDate,
          status,
          portions,
          pricePerPortion,
          totalPrice,
          packaging: cfg.location?.packaging ?? 'INDIVIDUAL',
          tags: cfg.location?.tags ?? [],
          source: cfg.orderType === 'FIXED' ? 'FIXED_AUTO' : 'MANUAL',
          confirmedAt,
          lockedAt,
        },
      })
      orderCount++

      if (status === 'DELIVERED' || status === 'OUT_FOR_DELIVERY') {
        await prisma.delivery.create({
          data: {
            orderId: order.id,
            type: Math.random() > 0.7 ? 'EXTERNAL_COURIER' : 'IN_HOUSE',
            courierName: Math.random() > 0.7 ? 'Яндекс.Доставка' : 'Костя (свой)',
            status: status === 'DELIVERED' ? 'DELIVERED' : 'EN_ROUTE',
            deliveredAt: status === 'DELIVERED' ? deliveryDate : null,
          },
        })
      }
    }
  }

  return orderCount
}
