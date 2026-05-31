import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { OrderForm } from './order-form'
import { requireRole } from '@/lib/auth/current-user'
import { listActiveClientsLight } from '@/lib/db/queries/orders'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'

interface PageProps {
  searchParams: Promise<{ date?: string; clientId?: string }>
}

export default async function NewOrderPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])

  const params = await searchParams
  const clients = await listActiveClientsLight()

  // Завтра по МСК как YYYY-MM-DD (Bug 7.25 — UTC-полночь MSK-календарного дня).
  const defaultDate = params.date ?? getMskCalendarDayUtc(new Date(), 1).toISOString().slice(0, 10)

  return (
    <>
      <div className="mb-6">
        <Link
          href="/orders"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К заказам
        </Link>
      </div>
      <PageHeader
        title="Новый заказ"
        subtitle="Ручное создание — например, по запросу из чата"
      />
      <OrderForm
        clients={clients}
        defaultDate={defaultDate}
        defaultClientId={params.clientId ?? null}
      />
    </>
  )
}
