import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { OrderDetail } from './order-detail'
import { requireRole } from '@/lib/auth/current-user'
import { getOrderDetail } from '@/lib/db/queries/orders'
import { listActiveOurLegalEntitiesForClientForm } from '@/app/(app)/clients/actions'
import { serialize } from '@/lib/utils/serialize'

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(['ADMIN', 'MANAGER'])
  const { id } = await params

  const [data, legalEntities] = await Promise.all([
    getOrderDetail(id),
    listActiveOurLegalEntitiesForClientForm(),
  ])
  if (!data) notFound()

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
        title="Карточка заказа"
        subtitle={`${data.order.client.name} · ${data.order.location.name}`}
      />
      <OrderDetail
        order={serialize(data.order)}
        history={serialize(data.history)}
        legalEntities={legalEntities}
      />
    </>
  )
}
