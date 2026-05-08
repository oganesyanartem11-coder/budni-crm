import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { ConfirmList } from './confirm-list'
import { requireRole } from '@/lib/auth/current-user'
import { listPendingConfirmation } from '@/lib/db/queries/orders'
import { serialize } from '@/lib/utils/serialize'

export default async function ConfirmPage() {
  await requireRole(['ADMIN', 'MANAGER'])
  const pending = await listPendingConfirmation()

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
        title="Подтверждение заказов"
        subtitle="Cut-off в 18:00. Введите количество порций по каждому клиенту."
      />
      <ConfirmList orders={serialize(pending)} />
    </>
  )
}
