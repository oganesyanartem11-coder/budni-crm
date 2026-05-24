import { prisma } from '@/lib/db/prisma'
import { getMondayOfWeek } from '@/lib/utils/week'
import type { MenuStatus } from '@prisma/client'

/**
 * Загружает меню для заданной недели со всеми блюдами и наборами.
 *
 * Приоритет статуса при дублях: APPROVED > PENDING_APPROVAL > DRAFT > ARCHIVED.
 * После Sprint 7.6 B.2 на MenuCycle.validFrom стоит @@unique — дубли в норме
 * невозможны, но эта последовательная стратегия остаётся защитой на случай
 * нарушения constraint'а или гонок до миграции данных.
 */
const STATUS_PRIORITY: MenuStatus[] = ['APPROVED', 'PENDING_APPROVAL', 'DRAFT', 'ARCHIVED']

export async function getMenuForWeek(weekStart: Date) {
  const monday = getMondayOfWeek(weekStart)

  for (const status of STATUS_PRIORITY) {
    const found = await prisma.menuCycle.findFirst({
      where: { validFrom: monday, status },
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
    if (found) return found
  }
  return null
}
