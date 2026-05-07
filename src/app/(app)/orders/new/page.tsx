import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { OrderForm } from './order-form'
import { requireRole } from '@/lib/auth/current-user'
import { listActiveClientsLight } from '@/lib/db/queries/orders'

interface PageProps {
  searchParams: Promise<{ date?: string; clientId?: string }>
}

export default async function NewOrderPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])

  const params = await searchParams
  const clients = await listActiveClientsLight()

  const defaultDate = (() => {
    if (params.date) return params.date
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  })()

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
