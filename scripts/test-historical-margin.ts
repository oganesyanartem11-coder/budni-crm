/**
 * Baseline-тест исторической маржи (C-1, блок C).
 *
 * Готовит минимальный набор MARGIN_TEST_*-данных, прогоняет
 * getMaterialCostForRange за три дня с разными ценами ингредиента в
 * priceHistory и сверяет с ожидаемой суммой 450₽ (100 + 150 + 200).
 * Дополнительно — sanity-проверка одного дня (25.05.2026 = 200₽).
 *
 * Запуск: `npm run test:margin`. Требует .env.test с локальным
 * Postgres.app. На прод НИКОГДА не должен быть наведён.
 */

import { prisma } from '../src/lib/db/prisma'
import { getMaterialCostForRange } from '../src/lib/digest/material-cost'
import type { DishCategory } from '@prisma/client'

const PREFIX = 'MARGIN_TEST_'
// Используем категорию-«мусорку», чтобы случайно не зацепиться за
// активные наборы / меню в локальной БД (см. enum DishCategory).
const TEST_CATEGORY: DishCategory = 'OTHER'

type CreatedIds = {
  orderIds: string[]
  menuDayDishIds: string[]
  menuDayIds: string[]
  menuCycleId: string | null
  mealSetItemIds: string[]
  mealSetId: string | null
  dishIngredientIds: string[]
  dishId: string | null
  priceHistoryIds: string[]
  ingredientId: string | null
  clientLocationId: string | null
  clientId: string | null
  ourLegalEntityId: string | null
}

async function main() {
  const created: CreatedIds = {
    orderIds: [],
    menuDayDishIds: [],
    menuDayIds: [],
    menuCycleId: null,
    mealSetItemIds: [],
    mealSetId: null,
    dishIngredientIds: [],
    dishId: null,
    priceHistoryIds: [],
    ingredientId: null,
    clientLocationId: null,
    clientId: null,
    ourLegalEntityId: null,
  }

  // Safety-net: убеждаемся, что подключаемся не к проду. Если в URL
  // присутствуют признаки production-БД — отказываемся работать.
  const url = process.env.DATABASE_URL ?? ''
  if (/neon\.tech|prod|production/i.test(url)) {
    console.error('❌ DATABASE_URL похож на прод/Neon — отказ. Используй .env.test.')
    process.exit(1)
  }

  try {
    // === ШАГ 1. Подготовка тестовых данных ===
    //
    // Транзакция interactive — локалка без pgbouncer, можно. Все
    // создания идут одной TX, чтобы при падении не оставить мусор.
    await prisma.$transaction(async (tx) => {
      // 1.1 OurLegalEntity (минимум обязательных полей).
      const legal = await tx.ourLegalEntity.create({
        data: {
          shortName: `${PREFIX}LE`,
          fullName: `${PREFIX}LE_FULL`,
          entityType: 'INDIVIDUAL_ENTREPRENEUR',
          inn: '0000000000',
          ogrn: '000000000000000',
          legalAddress: 'test',
          bankName: 'test-bank',
          bankBic: '000000000',
          bankAccount: '00000000000000000000',
          bankCorrAccount: '00000000000000000000',
          directorName: 'Test Director',
          lastDocumentNumber: 0,
          lastDocumentYear: 2026,
        },
      })
      created.ourLegalEntityId = legal.id

      // 1.2 Client (с привязкой к нашему юрлицу).
      const client = await tx.client.create({
        data: {
          name: `${PREFIX}CLIENT`,
          defaultOurLegalEntityId: legal.id,
        },
      })
      created.clientId = client.id

      // 1.3 ClientLocation.
      const location = await tx.clientLocation.create({
        data: {
          name: `${PREFIX}LOC`,
          address: 'test',
          packaging: 'INDIVIDUAL',
          clientId: client.id,
        },
      })
      created.clientLocationId = location.id

      // 1.4 Ingredient (текущая цена 20 — она же станет ценой на 25 мая).
      const ingredient = await tx.ingredient.create({
        data: {
          name: `${PREFIX}FLOUR`,
          unit: 'KG',
          pricePerUnit: 20,
          status: 'APPROVED',
          isActive: true,
        },
      })
      created.ingredientId = ingredient.id

      // 1.5 IngredientPriceHistory — три ступени:
      //     2026-05-01 → 10₽/кг, 2026-05-10 → 15₽/кг, 2026-05-20 → 20₽/кг.
      //     Так на 05.05 цена 10, на 15.05 цена 15, на 25.05 цена 20.
      const ph1 = await tx.ingredientPriceHistory.create({
        data: {
          ingredientId: ingredient.id,
          price: 10,
          validFrom: new Date('2026-05-01T00:00:00.000Z'),
        },
      })
      const ph2 = await tx.ingredientPriceHistory.create({
        data: {
          ingredientId: ingredient.id,
          price: 15,
          validFrom: new Date('2026-05-10T00:00:00.000Z'),
        },
      })
      const ph3 = await tx.ingredientPriceHistory.create({
        data: {
          ingredientId: ingredient.id,
          price: 20,
          validFrom: new Date('2026-05-20T00:00:00.000Z'),
        },
      })
      created.priceHistoryIds = [ph1.id, ph2.id, ph3.id]

      // 1.6 Dish (категория OTHER, PORTION, 1кг брутто = 1кг нетто).
      const dish = await tx.dish.create({
        data: {
          name: `${PREFIX}DISH`,
          category: TEST_CATEGORY,
          unit: 'PORTION',
          portionSize: null,
          isActive: true,
          status: 'APPROVED',
        },
      })
      created.dishId = dish.id

      // 1.7 DishIngredient: 1000г брутто/нетто.
      const di = await tx.dishIngredient.create({
        data: {
          dishId: dish.id,
          ingredientId: ingredient.id,
          bruttoGrams: 1000,
          nettoGrams: 1000,
        },
      })
      created.dishIngredientIds = [di.id]

      // 1.8 MealSet + один item категории OTHER (quantity=1).
      const mealSet = await tx.mealSet.create({
        data: {
          mealType: 'LUNCH',
          name: `${PREFIX}SET`,
          isDefault: false,
          isActive: true,
        },
      })
      created.mealSetId = mealSet.id

      const item = await tx.mealSetItem.create({
        data: {
          mealSetId: mealSet.id,
          dishCategory: TEST_CATEGORY,
          quantity: 1,
        },
      })
      created.mealSetItemIds = [item.id]

      // 1.9 MenuCycle APPROVED на май 2026.
      //     @@unique([validFrom]) — берём дату 2026-05-01, она вряд ли
      //     занята в локалке (на проде не запускаем, см. safety-net выше).
      const cycle = await tx.menuCycle.create({
        data: {
          name: `${PREFIX}CYCLE`,
          validFrom: new Date('2026-05-01T00:00:00.000Z'),
          validTo: new Date('2026-05-31T23:59:59.999Z'),
          status: 'APPROVED',
        },
      })
      created.menuCycleId = cycle.id

      // 1.10 MenuDay × 3 — для дней недели 05/15/25 мая 2026:
      //     2026-05-05 — вторник  (dayOfWeek=2)
      //     2026-05-15 — пятница  (dayOfWeek=5)
      //     2026-05-25 — понедельник (dayOfWeek=1)
      const daysOfWeek = [2, 5, 1] as const
      for (const dayOfWeek of daysOfWeek) {
        const menuDay = await tx.menuDay.create({
          data: {
            menuCycleId: cycle.id,
            dayOfWeek,
            mealType: 'LUNCH',
            mealSetId: mealSet.id,
          },
        })
        created.menuDayIds.push(menuDay.id)

        const mdd = await tx.menuDayDish.create({
          data: {
            menuDayId: menuDay.id,
            dishId: dish.id,
            slotCategory: TEST_CATEGORY,
          },
        })
        created.menuDayDishIds.push(mdd.id)
      }

      // 1.11 Order × 3 — по 10 порций DELIVERED на 05/15/25 мая.
      //      pricePerPortion=0 / totalPrice=0 — нам важна только cost-формула.
      const orderDates = [
        new Date('2026-05-05T09:00:00.000Z'),
        new Date('2026-05-15T09:00:00.000Z'),
        new Date('2026-05-25T09:00:00.000Z'),
      ]
      for (const deliveryDate of orderDates) {
        const order = await tx.order.create({
          data: {
            clientId: client.id,
            locationId: location.id,
            mealType: 'LUNCH',
            deliveryDate,
            status: 'DELIVERED',
            portions: 10,
            pricePerPortion: 0,
            totalPrice: 0,
            packaging: 'INDIVIDUAL',
            source: 'MANUAL',
            ourLegalEntityId: legal.id,
          },
        })
        created.orderIds.push(order.id)
      }
    })

    // === ШАГ 2. Прогон getMaterialCostForRange за весь май ===
    const result = await getMaterialCostForRange(
      new Date('2026-05-01T00:00:00.000Z'),
      new Date('2026-05-31T23:59:59.999Z'),
      ['DELIVERED'],
    )
    console.log('material-cost range result:', result)

    // Ожидаем: 100 + 150 + 200 = 450₽
    //   05.05: цена 10₽/кг × 1кг × 10 порций = 100
    //   15.05: цена 15₽/кг × 1кг × 10 порций = 150
    //   25.05: цена 20₽/кг × 1кг × 10 порций = 200
    const expected = 450
    const diff = Math.abs(result.totalCost - expected)
    if (diff > 0.01) {
      console.error(
        `❌ FAIL: expected ${expected}₽, got ${result.totalCost}₽ (diff ${diff}₽)`,
      )
      process.exit(1)
    }
    console.log(
      `✅ Historical margin: 3 days × different prices = ${result.totalCost}₽ as expected`,
    )

    // === ШАГ 3. Sanity: один день 25.05 ===
    // На 25.05 priceHistory даёт 20₽/кг, 10 порций × 1кг = 200₽.
    const oneDay = await getMaterialCostForRange(
      new Date('2026-05-25T00:00:00.000Z'),
      new Date('2026-05-25T23:59:59.999Z'),
      ['DELIVERED'],
    )
    if (Math.abs(oneDay.totalCost - 200) > 0.01) {
      console.error(
        `❌ FAIL: 25 мая ожидали 200₽, получили ${oneDay.totalCost}₽`,
      )
      process.exit(1)
    }
    console.log(`✅ Single-day sanity: 25 мая = ${oneDay.totalCost}₽`)
  } catch (err) {
    console.error('❌ Скрипт упал:', err)
    process.exit(1)
  } finally {
    // === ШАГ 4. Чистка в обратном порядке зависимостей ===
    // Каждый deleteMany — best-effort, ошибки логируем но не глотаем
    // фатально (последующие чистки всё равно нужно попробовать).
    try {
      if (created.orderIds.length > 0) {
        await prisma.order.deleteMany({ where: { id: { in: created.orderIds } } })
      }
      if (created.menuDayDishIds.length > 0) {
        await prisma.menuDayDish.deleteMany({
          where: { id: { in: created.menuDayDishIds } },
        })
      }
      if (created.menuDayIds.length > 0) {
        await prisma.menuDay.deleteMany({
          where: { id: { in: created.menuDayIds } },
        })
      }
      if (created.menuCycleId) {
        await prisma.menuCycle.deleteMany({ where: { id: created.menuCycleId } })
      }
      if (created.mealSetItemIds.length > 0) {
        await prisma.mealSetItem.deleteMany({
          where: { id: { in: created.mealSetItemIds } },
        })
      }
      if (created.mealSetId) {
        await prisma.mealSet.deleteMany({ where: { id: created.mealSetId } })
      }
      if (created.dishIngredientIds.length > 0) {
        await prisma.dishIngredient.deleteMany({
          where: { id: { in: created.dishIngredientIds } },
        })
      }
      if (created.dishId) {
        await prisma.dish.deleteMany({ where: { id: created.dishId } })
      }
      if (created.priceHistoryIds.length > 0) {
        await prisma.ingredientPriceHistory.deleteMany({
          where: { id: { in: created.priceHistoryIds } },
        })
      }
      if (created.ingredientId) {
        await prisma.ingredient.deleteMany({
          where: { id: created.ingredientId },
        })
      }
      if (created.clientLocationId) {
        await prisma.clientLocation.deleteMany({
          where: { id: created.clientLocationId },
        })
      }
      if (created.clientId) {
        await prisma.client.deleteMany({ where: { id: created.clientId } })
      }
      if (created.ourLegalEntityId) {
        await prisma.ourLegalEntity.deleteMany({
          where: { id: created.ourLegalEntityId },
        })
      }
    } catch (cleanupErr) {
      console.error('⚠ Cleanup частично не удался:', cleanupErr)
    }
    await prisma.$disconnect()
  }
}

main()
