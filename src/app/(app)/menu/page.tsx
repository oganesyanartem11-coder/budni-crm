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

  // 7.6 B.3: опознаём preview AI-импорта. Только для DRAFT — у APPROVED/PENDING/ARCHIVED
  // баннер бессмысленен. Связь cycle → import восстанавливается через Dish.menuImportId
  // (тот же канон что в expand-menu.getMenuStructureFromImport).
  let previewImportId: string | null = null
  if (menu && menu.status === 'DRAFT') {
    const source = await prisma.menuCycle.findUnique({
      where: { id: menu.id },
      select: {
        days: {
          orderBy: { dayOfWeek: 'asc' },
          take: 1,
          select: {
            dishes: {
              take: 1,
              select: {
                dish: {
                  select: {
                    menuImport: { select: { id: true, status: true } },
                  },
                },
              },
            },
          },
        },
      },
    })
    const imp = source?.days[0]?.dishes[0]?.dish?.menuImport
    if (imp && (imp.status === 'DRAFT' || imp.status === 'PENDING_APPROVAL')) {
      previewImportId = imp.id
    }
  }

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
        previewImportId={previewImportId}
      />
    </>
  )
}
