import Link from 'next/link'
import { Inbox as InboxIcon, ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { formatDateShort } from '@/lib/utils/format'
import type { InboxItemReason, InboxItemStatus } from '@prisma/client'
import { cn } from '@/lib/utils/cn'

interface PageProps {
  searchParams: Promise<{ show?: string }>
}

const REASON_LABELS: Record<InboxItemReason, string> = {
  NEW_CLIENT: 'Новый клиент',
  ANOMALY_HISTORICAL: 'Отклонение от нормы',
  ANOMALY_THRESHOLD: 'Подозрительное число',
  ANOMALY_LLM_CONFIDENCE: 'LLM не уверен',
  NON_NUMERIC: 'Не цифра',
  CANCELLATION_INTENT: 'Отмена',
  POST_CUTOFF: 'После cut-off',
}

const REASON_COLORS: Record<InboxItemReason, string> = {
  NEW_CLIENT: 'bg-info-bg text-info-fg',
  ANOMALY_HISTORICAL: 'bg-warning-bg text-warning-fg',
  ANOMALY_THRESHOLD: 'bg-warning-bg text-warning-fg',
  ANOMALY_LLM_CONFIDENCE: 'bg-warning-bg text-warning-fg',
  NON_NUMERIC: 'bg-neutral-bg text-neutral-fg',
  CANCELLATION_INTENT: 'bg-danger-bg text-danger-fg',
  POST_CUTOFF: 'bg-neutral-bg text-neutral-fg',
}

export default async function InboxPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])

  const params = await searchParams
  const showRead = params.show === 'read'
  const status: InboxItemStatus = showRead ? 'READ' : 'UNREAD'

  const items = await prisma.inboxItem.findMany({
    where: { status },
    include: {
      client: { select: { id: true, name: true, maxChatId: true, maxUsername: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  const unreadCount = showRead
    ? await prisma.inboxItem.count({ where: { status: 'UNREAD' } })
    : items.length

  return (
    <>
      <PageHeader
        title={showRead ? 'Прочитанные' : 'Входящие'}
        subtitle={
          showRead
            ? 'История обработанных обращений'
            : `Непрочитанных: ${unreadCount}`
        }
      />

      {showRead && (
        <div className="mb-5">
          <Link
            href="/inbox"
            className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            К непрочитанным
          </Link>
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          <InboxIcon className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
          <p className="font-medium text-fg mb-1">
            {showRead ? 'Прочитанных нет' : 'Все обращения обработаны'}
          </p>
          <p className="text-sm">
            {showRead ? 'История пуста.' : 'Новые сообщения появятся здесь автоматически.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <InboxRow key={item.id} item={item} />
          ))}
        </div>
      )}

      {!showRead && (
        <div className="mt-6 text-center">
          <Link
            href="/inbox?show=read"
            className="text-sm text-fg-muted hover:text-fg underline"
          >
            Показать прочитанные
          </Link>
        </div>
      )}
    </>
  )
}

type ItemRow = Awaited<ReturnType<typeof prisma.inboxItem.findMany>>[number] & {
  client: { id: string; name: string; maxChatId: string | null; maxUsername: string | null }
}

function InboxRow({ item }: { item: ItemRow }) {
  const isHigh = item.priority === 'HIGH'

  return (
    <Link
      href={`/inbox/${item.id}`}
      className={cn(
        'block rounded-2xl bg-surface border p-4 transition-all hover:border-border-strong',
        isHigh ? 'border-danger/30' : 'border-border'
      )}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-base truncate flex items-center gap-1.5">
            {item.client.name}
            {item.client.maxUsername && (
              <span title="Есть MAX-аккаунт" className="text-info-fg text-xs">●</span>
            )}
          </p>
          <p className="text-xs text-fg-subtle mt-0.5">{formatDateShort(item.createdAt)}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isHigh && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-pill bg-danger-bg text-danger-fg text-xs font-semibold">
              HIGH
            </span>
          )}
          <span className={cn('inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-medium', REASON_COLORS[item.reason as InboxItemReason])}>
            {REASON_LABELS[item.reason as InboxItemReason]}
          </span>
        </div>
      </div>
      {item.clientMessage && (
        <p className="text-sm text-fg-muted line-clamp-2">{item.clientMessage}</p>
      )}
      {item.humanReason && !item.clientMessage && (
        <p className="text-sm text-fg-muted line-clamp-2 italic">{item.humanReason}</p>
      )}
    </Link>
  )
}
