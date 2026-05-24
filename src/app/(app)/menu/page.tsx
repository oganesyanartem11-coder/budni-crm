import { PageHeader } from '@/components/layout/page-header'
import { MenuView } from './menu-view'
import { requireRole } from '@/lib/auth/current-user'
import { getMenuForWeek } from '@/lib/db/queries/menu'
import { getMondayOfWeek } from '@/lib/utils/week'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'

interface PageProps {
  searchParams: Promise<{ week?: string }>
}

export default async function MenuPage({ searchParams }: PageProps) {
  const user = await requireRole(['ADMIN', 'CHEF', 'MANAGER'])

  const params = await searchParams
  const weekDate = params.week ? new Date(params.week) : new Date()
  const monday = getMondayOfWeek(weekDate)

  const menu = await getMenuForWeek(monday)

  // --- Sprint 7.6 B.1 TEMP AUDIT: удалить следующим коммитом ---
  const allCyclesOnDay = await prisma.menuCycle.findMany({
    where: { validFrom: monday },
    select: { id: true, name: true, status: true, menuImportId: true, createdAt: true },
  })
  console.log(
    '[MENU_AUDIT]',
    JSON.stringify({
      monday: monday.toISOString(),
      found: !!menu,
      foundId: menu?.id,
      totalOnThisWeek: allCyclesOnDay.length,
      cycles: allCyclesOnDay.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        fromImport: !!c.menuImportId,
        createdAt: c.createdAt.toISOString(),
      })),
    })
  )
  const allCycles = await prisma.menuCycle.findMany({
    select: { validFrom: true, status: true },
  })
  const byWeek = new Map<string, { total: number; statuses: string[] }>()
  for (const c of allCycles) {
    const key = c.validFrom.toISOString()
    const row = byWeek.get(key) ?? { total: 0, statuses: [] }
    row.total += 1
    row.statuses.push(c.status)
    byWeek.set(key, row)
  }
  const duplicates = Array.from(byWeek.entries())
    .filter(([, v]) => v.total > 1)
    .map(([k, v]) => ({ monday: k, count: v.total, statuses: v.statuses }))
  console.log(
    '[MENU_AUDIT_GLOBAL]',
    JSON.stringify({
      totalCycles: allCycles.length,
      uniqueWeeks: byWeek.size,
      duplicatesFound: duplicates.length,
      duplicates,
    })
  )
  // --- END TEMP AUDIT ---

  // Загружаем все активные блюда. Редактор открывается только в DRAFT
  // (isEditable считается в menu-view), но для просмотра меню в других
  // статусах список блюд тоже нужен — каталог может быть полезен в read-only.
  const dishes = menu
    ? await prisma.dish.findMany({
        where: { isActive: true },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      })
    : []

  return (
    <>
      <PageHeader
        title="Меню недели"
        subtitle="Недельный план питания"
      />
      <MenuView
        weekStartIso={monday.toISOString()}
        menu={menu ? serialize(menu) : null}
        dishes={serialize(dishes)}
        userRole={user.role}
      />
    </>
  )
}
