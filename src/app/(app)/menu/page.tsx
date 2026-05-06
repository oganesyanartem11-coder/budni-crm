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

  // Загружаем все активные блюда — для редактора слотов (нужен только если есть DRAFT)
  const dishes = menu?.status === 'DRAFT'
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
