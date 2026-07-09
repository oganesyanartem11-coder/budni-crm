import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * Идемпотентный seed для 6.4-smoke. Создаёт 3 клиента / 4 точки с конфигами,
 * сегодняшние заказы в разных статусах (включая DELIVERED с опозданием для
 * проверки красной подсветки в DeliveredRow), и заказы на завтра LOCKED.
 * User-таблицу НЕ трогает — Dev Admin (PIN 1111) остаётся.
 */
async function main() {
  const dbInfo = await prisma.$queryRawUnsafe<Array<{ db: string }>>(
    'SELECT current_database() AS db'
  )
  console.log('Connected to DB:', dbInfo[0]?.db)

  // 1. Wipe бизнес-данные (порядок важен из-за FK).
  // FK onDelete: Cascade на Client покрывает BotConversation/BotMessage/InboxItem.
  await prisma.delivery.deleteMany()
  await prisma.order.deleteMany()
  await prisma.clientMealConfig.deleteMany()
  await prisma.clientLocation.deleteMany()
  await prisma.client.deleteMany()
  console.log('✓ Старые данные удалены')

  // 2. Сегодня/завтра в UTC-полночь МСК-даты (Vercel и Neon в UTC, MSK = UTC+3).
  const now = new Date()
  const mskToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  // Корректировка: если UTC < 21:00, MSK ещё «сегодня»; >=21:00 UTC = уже «завтра» в MSK.
  // Для простоты дев-сидов считаем что MSK-день = UTC-день (на Vercel CRON cutoff в 13:00 UTC=16:00 MSK).
  const today = mskToday
  const tomorrow = new Date(today)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)

  // Helper: построить deliveredAt в UTC из «HH:mm МСК» сегодня.
  const mskTimeToday = (hhmm: string): Date => {
    const [h, m] = hhmm.split(':').map(Number)
    const d = new Date(today)
    d.setUTCHours(h - 3, m, 0, 0)
    return d
  }

  // 3. Клиенты + локации + конфиги
  const sirius = await prisma.client.create({
    data: {
      name: 'ООО СИРИУС',
      contactPhone: '+79670619998',
      contactName: 'Анна (офис-менеджер)',
      notes: 'ИНН 7701234567',
      locations: {
        create: [
          {
            name: 'Мневники',
            address: 'Москва, Мневники 5',
            deliveryWindowFrom: '10:30',
            deliveryWindowTo: '11:00',
            packaging: 'INDIVIDUAL',
          },
        ],
      },
    },
    include: { locations: true },
  })
  const siriusLoc = sirius.locations[0]
  await prisma.clientMealConfig.create({
    data: {
      clientId: sirius.id,
      locationId: siriusLoc.id,
      mealType: 'LUNCH',
      orderType: 'FIXED',
      scheduleType: 'WEEKDAYS',
      fixedPortions: 37,
      pricePerPortion: 400,
    },
  })

  const officeStar = await prisma.client.create({
    data: {
      name: 'ООО ОФИС-СТАР',
      contactPhone: '+79161234567',
      contactName: 'Дмитрий',
      notes: 'ИНН 7702345678',
      locations: {
        create: [
          {
            name: 'Тверская',
            address: 'Москва, Тверская 15',
            deliveryWindowFrom: '12:00',
            deliveryWindowTo: '13:00',
            packaging: 'INDIVIDUAL',
          },
          {
            name: 'Арбат',
            address: 'Москва, Арбат 8',
            deliveryWindowFrom: '12:30',
            deliveryWindowTo: '13:30',
            packaging: 'INDIVIDUAL',
          },
        ],
      },
    },
    include: { locations: true },
  })
  const tverskaya = officeStar.locations.find((l) => l.name === 'Тверская')!
  const arbat = officeStar.locations.find((l) => l.name === 'Арбат')!
  await prisma.clientMealConfig.create({
    data: {
      clientId: officeStar.id,
      locationId: tverskaya.id,
      mealType: 'LUNCH',
      orderType: 'FIXED',
      scheduleType: 'WEEKDAYS',
      fixedPortions: 25,
      pricePerPortion: 450,
    },
  })
  await prisma.clientMealConfig.create({
    data: {
      clientId: officeStar.id,
      locationId: arbat.id,
      mealType: 'LUNCH',
      orderType: 'DYNAMIC',
      scheduleType: 'WEEKDAYS',
      fixedPortions: 15,
      pricePerPortion: 450,
    },
  })

  const school = await prisma.client.create({
    data: {
      name: 'ГБОУ Школа №22',
      contactPhone: '+74951234567',
      contactName: 'Ольга (завуч)',
      notes: 'ИНН 7703456789',
      locations: {
        create: [
          {
            name: 'Главное здание',
            address: 'Москва, Ленинский 50',
            deliveryWindowFrom: '08:30',
            deliveryWindowTo: '09:00',
            packaging: 'BULK',
          },
        ],
      },
    },
    include: { locations: true },
  })
  const schoolLoc = school.locations[0]
  await prisma.clientMealConfig.create({
    data: {
      clientId: school.id,
      locationId: schoolLoc.id,
      mealType: 'BREAKFAST',
      orderType: 'FIXED',
      scheduleType: 'WEEKDAYS',
      fixedPortions: 80,
      pricePerPortion: 250,
    },
  })

  // 4. Заказы на СЕГОДНЯ
  // (a) СИРИУС Мневники LUNCH — DELIVERED с большим опозданием (13:30 МСК vs окно 11:00)
  const siriusOrderToday = await prisma.order.create({
    data: {
      clientId: sirius.id,
      locationId: siriusLoc.id,
      mealType: 'LUNCH',
      deliveryDate: today,
      status: 'DELIVERED',
      portions: 37,
      pricePerPortion: 400,
      totalPrice: 37 * 400,
      packaging: 'INDIVIDUAL',
      source: 'FIXED_AUTO',
      confirmedAt: new Date(today.getTime() - 24 * 60 * 60 * 1000),
    },
  })
  await prisma.delivery.create({
    data: {
      orderId: siriusOrderToday.id,
      type: 'IN_HOUSE',
      status: 'DELIVERED',
      deliveredAt: mskTimeToday('13:30'),
      courierName: 'Иван Тестовый',
    },
  })

  // (b) ОФИС-СТАР Тверская LUNCH — OUT_FOR_DELIVERY (ещё не доставлено)
  await prisma.order.create({
    data: {
      clientId: officeStar.id,
      locationId: tverskaya.id,
      mealType: 'LUNCH',
      deliveryDate: today,
      status: 'OUT_FOR_DELIVERY',
      portions: 25,
      pricePerPortion: 450,
      totalPrice: 25 * 450,
      packaging: 'INDIVIDUAL',
      source: 'FIXED_AUTO',
      confirmedAt: new Date(today.getTime() - 24 * 60 * 60 * 1000),
    },
  })

  // (c) ОФИС-СТАР Арбат LUNCH — CONFIRMED
  await prisma.order.create({
    data: {
      clientId: officeStar.id,
      locationId: arbat.id,
      mealType: 'LUNCH',
      deliveryDate: today,
      status: 'CONFIRMED',
      portions: 15,
      pricePerPortion: 450,
      totalPrice: 15 * 450,
      packaging: 'INDIVIDUAL',
      source: 'BOT',
      confirmedAt: new Date(today.getTime() - 8 * 60 * 60 * 1000),
    },
  })

  // (d) Школа №22 BREAKFAST — DELIVERED вовремя (08:50 МСК, окно до 09:00)
  const schoolOrderToday = await prisma.order.create({
    data: {
      clientId: school.id,
      locationId: schoolLoc.id,
      mealType: 'BREAKFAST',
      deliveryDate: today,
      status: 'DELIVERED',
      portions: 80,
      pricePerPortion: 250,
      totalPrice: 80 * 250,
      packaging: 'BULK',
      source: 'FIXED_AUTO',
      confirmedAt: new Date(today.getTime() - 24 * 60 * 60 * 1000),
    },
  })
  await prisma.delivery.create({
    data: {
      orderId: schoolOrderToday.id,
      type: 'IN_HOUSE',
      status: 'DELIVERED',
      deliveredAt: mskTimeToday('08:50'),
      courierName: 'Иван Тестовый',
    },
  })

  // 5. Заказы на ЗАВТРА — все LOCKED
  const tomorrowStops = [
    { clientId: sirius.id, locationId: siriusLoc.id, mealType: 'LUNCH' as const, portions: 37, pricePerPortion: 400, packaging: 'INDIVIDUAL' as const },
    { clientId: officeStar.id, locationId: tverskaya.id, mealType: 'LUNCH' as const, portions: 25, pricePerPortion: 450, packaging: 'INDIVIDUAL' as const },
    { clientId: officeStar.id, locationId: arbat.id, mealType: 'LUNCH' as const, portions: 15, pricePerPortion: 450, packaging: 'INDIVIDUAL' as const },
    { clientId: school.id, locationId: schoolLoc.id, mealType: 'BREAKFAST' as const, portions: 80, pricePerPortion: 250, packaging: 'BULK' as const },
  ]
  for (const s of tomorrowStops) {
    await prisma.order.create({
      data: {
        clientId: s.clientId,
        locationId: s.locationId,
        mealType: s.mealType,
        deliveryDate: tomorrow,
        status: 'LOCKED',
        portions: s.portions,
        pricePerPortion: s.pricePerPortion,
        totalPrice: s.portions * s.pricePerPortion,
        packaging: s.packaging,
        source: 'FIXED_AUTO',
        confirmedAt: new Date(),
      },
    })
  }

  // 6. Сводка
  const [clientsCount, locationsCount, configsCount, ordersCount, deliveriesCount] =
    await Promise.all([
      prisma.client.count(),
      prisma.clientLocation.count(),
      prisma.clientMealConfig.count(),
      prisma.order.count(),
      prisma.delivery.count(),
    ])

  console.log('\n✓ Создано:')
  console.log('  Клиентов:    ', clientsCount)
  console.log('  Локаций:     ', locationsCount)
  console.log('  Конфигов:    ', configsCount)
  console.log('  Заказов:     ', ordersCount)
  console.log('  Доставок:    ', deliveriesCount)
  console.log('\nДля smoke 6.4-fix-2: СИРИУС Мневники DELIVERED в 13:30 МСК vs окно 11:00 → опоздание ~150 мин в /delivery.')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('✗ Ошибка:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
