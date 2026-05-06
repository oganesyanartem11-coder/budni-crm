import { prisma } from '@/lib/db/prisma'
import { getMondayOfWeek, getSundayOfWeek } from '@/lib/utils/week'

/**
 * Загружает меню для заданной недели со всеми блюдами и наборами.
 */
export async function getMenuForWeek(weekStart: Date) {
  const monday = getMondayOfWeek(weekStart)

  return prisma.menuCycle.findFirst({
    where: { validFrom: monday },
    include: {
      approvedBy: { select: { id: true, name: true } },
      days: {
        include: {
          mealSet: {
            include: {
              items: true,
            },
          },
          dishes: {
            include: { dish: true },
          },
        },
        orderBy: [{ dayOfWeek: 'asc' }, { mealType: 'asc' }],
      },
    },
  })
}
