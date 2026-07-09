/**
 * Топ-ап к prisma/seed/index.ts для проверки margin/hero на budni_test.
 *
 * 1. Добавляет несколько PENDING_CONFIRMATION заказов на СЕГОДНЯ — чтобы
 *    блок «Требует действия» на дашборде отрисовался (базовый seed кладёт
 *    pending только на завтра). Идемпотентно: удаляет свои прошлые
 *    (note = PILOT_MARKER) перед вставкой.
 * 2. Выводит верификацию: счётчики клиентов/конфигов/заказов, распределение
 *    по статусам, заказы сегодня/завтра/pending, и РЕАЛЬНЫЙ margin за тек.
 *    финансовую неделю/месяц через getMarginForPeriod (та же функция, что
 *    рендерит FinanceWeekBlock).
 *
 * Запуск: dotenv -e .env.test -- tsx scripts/seed-pilot-topup.ts
 * Safety: отказ если DATABASE_URL похож на прод.
 */
import { prisma } from '@/lib/db/prisma'
import { getMarginForPeriod } from '@/lib/db/queries/dashboard-stats'
import { getFinancialWeek, getPresetRange } from '@/lib/utils/week'
import { countPendingConfirmationToday } from '@/lib/db/queries/orders'

const PILOT_MARKER = 'PILOT_PENDING_TODAY'
const PENDING_TODAY_COUNT = 3

function dateOnly(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (/neon\.tech|prod|production|amazonaws|supabase/i.test(dbUrl)) {
    console.error('❌ DATABASE_URL похож на прод. Топ-ап только для локалки.')
    process.exit(1)
  }

  const today = dateOnly(new Date())

  // --- 1. Идемпотентный pending-today ---
  await prisma.order.deleteMany({ where: { notes: PILOT_MARKER } })

  // Берём активные DYNAMIC-конфиги (pending осмысленен для динамики); если их
  // нет — любые активные конфиги.
  let configs = await prisma.clientMealConfig.findMany({
    where: { isActive: true, orderType: 'DYNAMIC' },
    include: { location: true },
    take: PENDING_TODAY_COUNT,
  })
  if (configs.length === 0) {
    configs = await prisma.clientMealConfig.findMany({
      where: { isActive: true },
      include: { location: true },
      take: PENDING_TODAY_COUNT,
    })
  }

  let created = 0
  for (const cfg of configs) {
    if (!cfg.locationId) continue
    const portions = cfg.fixedPortions ?? 15
    const price = Number(cfg.pricePerPortion)
    await prisma.order.create({
      data: {
        clientId: cfg.clientId,
        locationId: cfg.locationId,
        mealType: cfg.mealType,
        deliveryDate: today,
        status: 'PENDING_CONFIRMATION',
        portions,
        pricePerPortion: price,
        totalPrice: price * portions,
        packaging: cfg.location?.packaging ?? 'INDIVIDUAL',
        source: 'MANUAL',
        notes: PILOT_MARKER,
      },
    })
    created++
  }
  console.log(`\n➕ PENDING_CONFIRMATION на сегодня добавлено: ${created}`)

  // --- 2. Верификация ---
  const [clients, locations, configsTotal, orders, byStatus, pendingToday] = await Promise.all([
    prisma.client.count(),
    prisma.clientLocation.count(),
    prisma.clientMealConfig.count(),
    prisma.order.count(),
    prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    countPendingConfirmationToday(),
  ])

  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  const dayAfter = new Date(today)
  dayAfter.setDate(today.getDate() + 2)
  const [todayOrders, tomorrowOrders] = await Promise.all([
    prisma.order.count({ where: { deliveryDate: { gte: today, lt: tomorrow } } }),
    prisma.order.count({ where: { deliveryDate: { gte: tomorrow, lt: dayAfter } } }),
  ])

  console.log('\n=== СЧЁТЧИКИ ===')
  console.log(`clients:            ${clients}`)
  console.log(`locations:          ${locations}`)
  console.log(`mealConfigs:        ${configsTotal}`)
  console.log(`orders (всего):     ${orders}`)
  console.log(`pendingToday (блок «Требует действия», today+tomorrow): ${pendingToday}`)
  console.log(`заказов на сегодня: ${todayOrders}`)
  console.log(`заказов на завтра:  ${tomorrowOrders}`)
  console.log('\nРаспределение по статусам:')
  for (const row of byStatus.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${row.status.padEnd(22)} ${row._count._all}`)
  }

  // --- 3. РЕАЛЬНЫЙ margin (как на дашборде) ---
  const fw = getFinancialWeek(new Date())
  const month = getPresetRange('this_month')
  const [marginWeek, marginMonth] = await Promise.all([
    getMarginForPeriod(fw.from, fw.to),
    getMarginForPeriod(month.from, month.to),
  ])

  console.log('\n=== MARGIN (getMarginForPeriod — та же функция, что в FinanceWeekBlock) ===')
  const fmt = (m: typeof marginWeek, label: string) => {
    console.log(`${label}:`)
    console.log(`  выручка:       ${m.totalRevenue.toFixed(2)} ₽`)
    console.log(`  себестоимость: ${m.totalCost.toFixed(2)} ₽`)
    console.log(`  маржа абс:     ${m.marginAbsolute.toFixed(2)} ₽`)
    console.log(`  маржа %:       ${m.marginPct === null ? '—' : m.marginPct + '%'}`)
    const ok = m.marginPct !== null && m.marginPct >= 20 && m.marginPct <= 55
    console.log(`  цель 25-45%:   ${m.marginPct === null ? '⚠️ null' : ok ? '✅ осмысленно' : '⚠️ вне ожидаемого диапазона'}`)
  }
  fmt(marginWeek, 'Эта финансовая неделя')
  fmt(marginMonth, 'Этот месяц')

  console.log('\n✅ Топ-ап + верификация готовы. Логин PIN 1111 (Админ Дёмо).')
}

main()
  .catch((err) => {
    console.error('❌ Топ-ап упал:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
