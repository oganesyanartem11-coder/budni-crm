import Link from 'next/link'
import { Inbox as InboxIcon } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { formatDateShort } from '@/lib/utils/format'
import type { InboxItemReason, InboxItemPriority, InboxItemStatus } from '@prisma/client'
import { cn } from '@/lib/utils/cn'

type Filter = 'open' | 'all' | 'resolved'

interface PageProps {
  searchParams: Promise<{ filter?: string }>
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
  const filter = (params.filter as Filter) ?? 'open'

  const statusFilter =
    filter === 'all'
      ? undefined
      : filter === 'open'
        ? ['OPEN' as InboxItemStatus]
        : (['RESOLVED_SENT', 'RESOLVED_IGNORED'] as InboxItemStatus[])

  const items = await prisma.inboxItem.findMany({
    where: { status: statusFilter ? { in: statusFilter } : undefined },
    include: {
      client: { select: { id: true, name: true, maxChatId: true } },
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    take: 50,
  })

  const openCount = await prisma.inboxItem.count({ where: { status: 'OPEN' } })

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle={`Открыто: ${openCount}`}
      />

      <div className="flex items-center gap-1.5 mb-5">
        {(['open', 'all', 'resolved'] as Filter[]).map((f) => (
          <Link
            key={f}
            href={`/inbox?filter=${f}`}
            className={cn(
              'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors',
              filter === f ? 'bg-accent text-accent-fg' : 'bg-bg text-fg-muted hover:text-fg hover:bg-border'
            )}
          >
            {f === 'open' ? 'Открытые' : f === 'all' ? 'Все' : 'Закрытые'}
          </Link>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          <InboxIcon className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
          <p className="font-medium text-fg mb-1">Inbox пуст</p>
          <p className="text-sm">{filter === 'open' ? 'Все обращения обработаны.' : 'Здесь ничего нет.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <InboxRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </>
  )
}

function InboxRow({ item }: { item: Awaited<ReturnType<typeof prisma.inboxItem.findMany>>[number] & { client: { id: string; name: string; maxChatId: string | null } } }) {
  const isResolved = item.status !== 'OPEN'
  const isHigh = item.priority === 'HIGH'

  return (
    <Link
      href={`/inbox/${item.id}`}
      className={cn(
        'block rounded-2xl bg-surface border p-4 transition-all hover:border-border-strong',
        isHigh && !isResolved ? 'border-danger/30' : 'border-border',
        isResolved && 'opacity-70'
      )}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-base truncate">{item.client.name}</p>
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
          {isResolved && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-pill bg-success-bg text-success-fg text-xs font-medium">
              {item.status === 'RESOLVED_SENT' ? 'Ответил' : 'Закрыт'}
            </span>
          )}
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

const _priorityKeys: InboxItemPriority[] = ['NORMAL', 'HIGH']
void _priorityKeys
