import Link from 'next/link'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { OrdersView } from './orders-view'
import { requireRole } from '@/lib/auth/current-user'
import { listOrders, listOrdersForWeek, listActiveClientsLight } from '@/lib/db/queries/orders'
import { getMondayOfWeek } from '@/lib/utils/week'
import { formatDateShort } from '@/lib/utils/format'
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

  // Подзаголовок с датой для list-view: «Завтра, Чт, 15 мая» по умолчанию,
  // иначе просто формат даты выбранной даты. Для week-view дата меняется
  // в самом WeekView, на уровне страницы не нужна.
  const isDefaultTomorrow = view === 'list'
    && selectedDate.getTime() === defaultDate.getTime()
  const dateLabel = view === 'list'
    ? (isDefaultTomorrow ? `Завтра, ${formatDateShort(selectedDate)}` : formatDateShort(selectedDate))
    : 'Все заказы по датам, статусам и клиентам'

  return (
    <>
      <PageHeader
        title="Заказы"
        subtitle={dateLabel}
        actions={
          <Link
            href="/orders/new"
            className="px-4 sm:px-5 py-2.5 rounded-xl bg-brand-orange text-white font-medium text-sm hover:bg-brand-orange-dark transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/40 [touch-action:manipulation]"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Создать заказ</span>
          </Link>
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
