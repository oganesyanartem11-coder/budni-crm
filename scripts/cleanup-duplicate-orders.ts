import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  // Группировка по бизнес-ключу. Если в группе больше одного заказа —
  // оставляем самый старый (с минимальным createdAt), остальные — удаляем.

  const all = await prisma.order.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      clientId: true,
      locationId: true,
      mealType: true,
      deliveryDate: true,
      sourceConfigId: true,
      source: true,
      createdAt: true,
      status: true,
    },
  })

  // Группа = clientId|locationId|mealType|deliveryDate(YYYY-MM-DD)
  const groups = new Map<string, typeof all>()
  for (const o of all) {
    const dateKey = o.deliveryDate.toISOString().slice(0, 10)
    const key = `${o.clientId}|${o.locationId}|${o.mealType}|${dateKey}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(o)
  }

  const toDelete: string[] = []
  let groupsWithDupes = 0
  for (const [key, items] of groups.entries()) {
    if (items.length <= 1) continue
    groupsWithDupes++

    // Сортируем: оставить самый старый. Если есть FIXED_AUTO, и есть нечто более раннее без AUTO — удаляем AUTO.
    const sorted = [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    const toKeep = sorted[0]
    const dupes = sorted.slice(1)
    console.log(`[dupe] ${key}: ${items.length} заказов, оставляем ${toKeep.id} (${toKeep.source}), удаляем ${dupes.length}`)
    for (const d of dupes) {
      toDelete.push(d.id)
    }
  }

  if (toDelete.length === 0) {
    console.log('Дублей не найдено')
    return
  }

  console.log(`\nГрупп с дублями: ${groupsWithDupes}`)
  console.log(`Заказов к удалению: ${toDelete.length}`)

  // Удаляем связанные Delivery (если есть), потом сами Order
  await prisma.delivery.deleteMany({ where: { orderId: { in: toDelete } } })
  const deleted = await prisma.order.deleteMany({ where: { id: { in: toDelete } } })
  console.log(`Удалено заказов: ${deleted.count}`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
