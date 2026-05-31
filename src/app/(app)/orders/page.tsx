import Link from 'next/link'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { OrdersView } from './orders-view'
import { requireRole } from '@/lib/auth/current-user'
import { listOrders, listOrdersForWeek, listActiveClientsLight } from '@/lib/db/queries/orders'
import { getMondayOfWeek } from '@/lib/utils/week'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
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

  // Дата по умолчанию: завтра по МСК (Bug 7.25 — раньше серверный UTC new Date()
  // в окне 00:00–03:00 МСК давал «завтра» на день раньше). Всё считаем в UTC
  // детерминированно (без локального setHours, который на MSK-машине сдвигал бы
  // UTC-полночь на день назад): ?date=YYYY-MM-DD → UTC-полночь той же даты,
  // dateEnd = +24ч−1мс. @db.Date deliveryDate хранится как UTC-полночь.
  const defaultDate = getMskCalendarDayUtc(new Date(), 1)
  const selectedDate = params.date ? new Date(`${params.date}T00:00:00.000Z`) : defaultDate
  const dateEnd = new Date(selectedDate.getTime() + 24 * 60 * 60 * 1000 - 1)

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
            style={{ background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }}
            className="px-4 sm:px-5 py-2.5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [touch-action:manipulation]"
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
