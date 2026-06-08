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

  // 7.40: если хоть у одной локации в pending включён same-day cut-off,
  // единого «16:00» больше нет — показываем нейтральный subtitle.
  const hasSameDay = pending.some((o) => o.location.sameDayDelivery)
  const subtitle = hasSameDay
    ? 'Приём заявок индивидуальный по локациям. Введите количество порций по каждому клиенту.'
    : 'Приём заявок до 16:00. Введите количество порций по каждому клиенту.'

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
        subtitle={subtitle}
      />
      <ConfirmList orders={serialize(pending)} />
    </>
  )
}
