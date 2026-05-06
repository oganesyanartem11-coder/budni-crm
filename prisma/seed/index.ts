import { PrismaClient } from '@prisma/client'
import { seedIngredients } from './ingredients'
import { seedDishes } from './dishes'
import { seedMealSets } from './meal-sets'
import { seedClients } from './clients'
import { seedMenu } from './menu'
import { seedOrders, clearRecentOrders } from './orders'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Запуск seed-скрипта для CRM «Будни»\n')

  console.log('1/7 Ингредиенты...')
  const ingredients = await seedIngredients(prisma)
  console.log(`    ✓ ${ingredients.size} ингредиентов\n`)

  console.log('2/7 Блюда + техкарты...')
  const dishes = await seedDishes(prisma, ingredients)
  console.log(`    ✓ ${dishes.size} блюд\n`)

  console.log('3/7 Типовые наборы (завтрак/обед/ужин)...')
  const mealSets = await seedMealSets(prisma)
  console.log(`    ✓ ${mealSets.size} наборов\n`)

  console.log('4/7 Очистка старых заказов и доставок (последние 30 дней)...')
  await clearRecentOrders(prisma)
  console.log(`    ✓ заказы и доставки очищены\n`)

  console.log('5/7 Клиенты + точки + конфиги питания...')
  const clientsResult = await seedClients(prisma)
  console.log(`    ✓ ${clientsResult.clientCount} клиентов, ${clientsResult.locationCount} точек, ${clientsResult.configCount} конфигов\n`)

  console.log('6/7 Утверждённое меню на текущую неделю...')
  const menu = await seedMenu(prisma, dishes, mealSets)
  console.log(`    ✓ Меню "${menu.name}"\n`)

  console.log('7/7 История заказов (14 дней)...')
  const orderCount = await seedOrders(prisma)
  console.log(`    ✓ ${orderCount} заказов создано\n`)

  console.log('✅ Seed завершён успешно.\n')
  console.log('Тестовые PIN-коды для входа:')
  console.log('  1111 — Админ Дёмо')
  console.log('  2222 — Менеджер Маша')
  console.log('  3333 — Шеф Сергей')
  console.log('  4444 — Курьер Костя')
}

main()
  .catch((e) => {
    console.error('❌ Ошибка seed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
