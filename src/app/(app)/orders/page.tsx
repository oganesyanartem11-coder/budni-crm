import Link from 'next/link'
import { Plus, Sparkles } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { OrdersView } from './orders-view'
import { requireRole } from '@/lib/auth/current-user'
import { listOrders, listOrdersForWeek, listActiveClientsLight } from '@/lib/db/queries/orders'
import { getMondayOfWeek } from '@/lib/utils/week'
import { serialize } from '@/lib/utils/serialize'
import type { OrderStatus, MealType } from '@prisma/client'

interface PageProps {
  searchParams: Promise<{
    view?: string
    date?: string
    weekStart?: string
    clientId?: string
    mealType?: string
    status?: string
    search?: string
  }>
}

export default async function OrdersPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])

  const params = await searchParams
  const view: 'list' | 'week' = params.view === 'week' ? 'week' : 'list'

  // Дата по умолчанию: завтра
  const defaultDate = (() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(0, 0, 0, 0)
    return d
  })()
  const selectedDate = params.date ? new Date(params.date) : defaultDate
  selectedDate.setHours(0, 0, 0, 0)

  // Дата конца дня — для фильтра
  const dateEnd = new Date(selectedDate)
  dateEnd.setHours(23, 59, 59, 999)

  // Список клиентов для фильтра
  const clients = await listActiveClientsLight()

  let listOrdersData = null
  let weekOrdersData = null
  let weekStartDate: Date | null = null

  if (view === 'list') {
    listOrdersData = await listOrders({
      dateFrom: selectedDate,
      dateTo: dateEnd,
      clientId: params.clientId,
      mealType: (params.mealType as MealType | undefined) || undefined,
      status: (params.status as OrderStatus | undefined) || undefined,
      search: params.search,
    })
  } else {
    weekStartDate = params.weekStart ? new Date(params.weekStart) : getMondayOfWeek(new Date())
    weekStartDate = getMondayOfWeek(weekStartDate)
    weekOrdersData = await listOrdersForWeek(weekStartDate)
  }

  return (
    <>
      <PageHeader
        title="Заказы"
        subtitle="Все заказы по датам, статусам и клиентам"
        actions={
          <>
            <button
              type="button"
              disabled
              title="Будет доступно в Спринте 5"
              className="px-4 py-2 rounded-pill border border-border bg-surface text-fg-subtle font-medium text-sm flex items-center gap-2 cursor-not-allowed"
            >
              <Sparkles className="w-4 h-4" />
              <span className="hidden sm:inline">Из мессенджера</span>
            </button>
            <Link
              href="/orders/new"
              className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Создать заказ</span>
            </Link>
          </>
        }
      />

      <OrdersView
        view={view}
        selectedDateIso={selectedDate.toISOString()}
        weekStartIso={weekStartDate?.toISOString() ?? null}
        listOrders={listOrdersData ? serialize(listOrdersData) : null}
        weekOrders={weekOrdersData ? serialize(weekOrdersData) : null}
        clients={clients}
        filters={{
          clientId: params.clientId ?? '',
          mealType: params.mealType ?? '',
          status: params.status ?? '',
          search: params.search ?? '',
        }}
      />
    </>
  )
}
