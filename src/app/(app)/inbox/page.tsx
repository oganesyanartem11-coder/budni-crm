import Link from 'next/link'
import { Inbox as InboxIcon, ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { formatDateShort } from '@/lib/utils/format'
import type { InboxItemReason, InboxItemStatus } from '@prisma/client'
import { cn } from '@/lib/utils/cn'
import { ClientReadGroup } from './client-read-group'

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

interface InboxItemLite {
  id: string
  reason: InboxItemReason
  priority: 'NORMAL' | 'HIGH'
  clientMessage: string | null
  humanReason: string | null
  createdAt: Date
}

interface GroupedClient {
  id: string
  name: string
  maxUsername: string | null
  items: InboxItemLite[]
}

export default async function InboxPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])

  const params = await searchParams
  const showRead = params.show === 'read'
  const status: InboxItemStatus = showRead ? 'READ' : 'UNREAD'

  // Прямой запрос всех items со статусом + клиентом — потом группируем в JS.
  // Так проще чем relation-traversal через Client (требует back-reference Client.inboxItems).
  const items = await prisma.inboxItem.findMany({
    where: { status },
    include: { client: { select: { id: true, name: true, maxUsername: true } } },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  })

  // Группируем по клиенту, последнее сообщение наверху
  const grouped = new Map<string, GroupedClient>()
  for (const item of items) {
    const cid = item.clientId
    let g = grouped.get(cid)
    if (!g) {
      g = {
        id: item.client.id,
        name: item.client.name,
        maxUsername: item.client.maxUsername,
        items: [],
      }
      grouped.set(cid, g)
    }
    if (g.items.length < 10) {
      g.items.push({
        id: item.id,
        reason: item.reason,
        priority: item.priority,
        clientMessage: item.clientMessage,
        humanReason: item.humanReason,
        createdAt: item.createdAt,
      })
    }
  }

  const groups = Array.from(grouped.values())

  return (
    <>
      <PageHeader
        title={showRead ? 'Прочитанные' : 'Входящие'}
        subtitle={
          showRead
            ? `Клиентов: ${groups.length}`
            : `Непрочитанных клиентов: ${groups.length}`
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

      {groups.length === 0 ? (
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
          {groups.map((g) =>
            showRead ? (
              <ClientReadGroup
                key={g.id}
                client={g}
                reasonLabels={REASON_LABELS}
                reasonColors={REASON_COLORS}
              />
            ) : (
              <UnreadClientRow
                key={g.id}
                client={g}
                reasonLabels={REASON_LABELS}
                reasonColors={REASON_COLORS}
              />
            ),
          )}
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

function UnreadClientRow({
  client,
  reasonLabels,
  reasonColors,
}: {
  client: GroupedClient
  reasonLabels: Record<InboxItemReason, string>
  reasonColors: Record<InboxItemReason, string>
}) {
  const latest = client.items[0]
  const hasHigh = client.items.some((i) => i.priority === 'HIGH')

  // Клик ведёт на ПЕРВЫЙ (самый свежий) UNREAD-item этого клиента
  return (
    <Link
      href={`/inbox/${latest.id}`}
      className={cn(
        'block rounded-2xl bg-surface border p-4 transition-all hover:border-border-strong',
        hasHigh ? 'border-danger/30' : 'border-border',
      )}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-base truncate flex items-center gap-1.5">
            {client.name}
            {client.maxUsername && (
              <span title="Есть MAX-аккаунт" className="text-info-fg text-xs">●</span>
            )}
          </p>
          <p className="text-xs text-fg-subtle mt-0.5">{formatDateShort(latest.createdAt)}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {client.items.length > 1 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-pill bg-info-bg text-info-fg text-xs font-semibold">
              {client.items.length} непрочитанных
            </span>
          )}
          {hasHigh && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-pill bg-danger-bg text-danger-fg text-xs font-semibold">
              HIGH
            </span>
          )}
          <span className={cn('inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-medium', reasonColors[latest.reason])}>
            {reasonLabels[latest.reason]}
          </span>
        </div>
      </div>
      {latest.clientMessage && (
        <p className="text-sm text-fg-muted line-clamp-2">{latest.clientMessage}</p>
      )}
      {latest.humanReason && !latest.clientMessage && (
        <p className="text-sm text-fg-muted line-clamp-2 italic">{latest.humanReason}</p>
      )}
    </Link>
  )
}
