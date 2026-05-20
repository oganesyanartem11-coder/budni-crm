import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { formatDateLong } from '@/lib/utils/format'
import { serialize } from '@/lib/utils/serialize'
import { StatusChip } from '@/lib/menu-import/status-chip'
import { ProgressView } from './progress-view'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function MenuImportPage({ params }: PageProps) {
  const user = await requireRole(['ADMIN', 'CHEF'])
  const { id } = await params

  const mi = await prisma.menuImport.findUnique({
    where: { id },
    select: {
      id: true,
      source: true,
      status: true,
      progress: true,
      reason: true,
      errorMessage: true,
      approvedAt: true,
      rejectionComment: true,
      startDate: true,
      approvedBy: { select: { name: true } },
      createdAt: true,
      createdBy: { select: { name: true } },
      _count: { select: { dishes: true } },
    },
  })

  if (!mi) notFound()

  // Если импорт готов — подгружаем дерево меню, список блюд с техкартами
  // и каталог всех Ingredient (для IngredientPicker при редактировании состава).
  // Циклы связаны с импортом косвенно через Dish.menuImportId → MenuDayDish → MenuDay → MenuCycle
  // (схема MenuImport.menuCycleId одиночная, у нас может быть >1 недели).
  let importData: {
    dishes: ReturnType<typeof serialize<Awaited<ReturnType<typeof loadDishes>>>>
    menuCycles: ReturnType<typeof serialize<Awaited<ReturnType<typeof loadMenuCycles>>>>
    allIngredients: Awaited<ReturnType<typeof loadAllIngredients>>
  } | null = null

  if (mi.progress === 'READY') {
    const [dishes, menuCycles, allIngredients] = await Promise.all([
      loadDishes(id),
      loadMenuCycles(id),
      loadAllIngredients(),
    ])
    importData = {
      dishes: serialize(dishes),
      menuCycles: serialize(menuCycles),
      allIngredients,
    }
  }

  return (
    <>
      <PageHeader
        title="Импорт меню"
        subtitle={`Загрузил ${mi.createdBy?.name ?? '—'} · ${formatDateLong(mi.createdAt)} · ${mi.source === 'EXCEL' ? 'Excel' : 'Фото'}`}
        actions={
          <>
            <StatusChip status={mi.status} />
            <Link
              href="/menu/imports"
              className="px-4 py-2 rounded-pill border border-border text-fg text-sm hover:bg-fg/5 transition-colors flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              К списку
            </Link>
          </>
        }
      />
      <ProgressView
        menuImportId={mi.id}
        initialProgress={mi.progress}
        initialReason={mi.reason}
        initialErrorMessage={mi.errorMessage}
        dishesCount={mi._count.dishes}
        importStatus={mi.status}
        importData={importData}
        userRole={user.role}
        approval={{
          approvedAt: mi.approvedAt,
          rejectionComment: mi.rejectionComment,
          startDate: mi.startDate,
          approvedByName: mi.approvedBy?.name ?? null,
        }}
      />
    </>
  )
}

function loadDishes(menuImportId: string) {
  return prisma.dish.findMany({
    where: { menuImportId },
    orderBy: { correctedName: 'asc' },
    include: {
      ingredients: {
        orderBy: { ingredient: { name: 'asc' } },
        include: {
          ingredient: {
            select: { id: true, name: true, unit: true, pricePerUnit: true },
          },
        },
      },
    },
  })
}

function loadMenuCycles(menuImportId: string) {
  return prisma.menuCycle.findMany({
    where: { days: { some: { dishes: { some: { dish: { menuImportId } } } } } },
    orderBy: { validFrom: 'asc' },
    include: {
      days: {
        orderBy: [{ dayOfWeek: 'asc' }, { mealType: 'asc' }],
        include: {
          dishes: {
            orderBy: { slotCategory: 'asc' },
            include: {
              dish: {
                select: {
                  id: true,
                  name: true,
                  correctedName: true,
                  category: true,
                  correctionLevel: true,
                },
              },
            },
          },
        },
      },
    },
  })
}

function loadAllIngredients() {
  return prisma.ingredient.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, unit: true },
  })
}
