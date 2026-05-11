'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { formatDateShort } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import type { InboxItemReason } from '@prisma/client'

interface InboxItemLite {
  id: string
  reason: InboxItemReason
  priority: 'NORMAL' | 'HIGH'
  clientMessage: string | null
  humanReason: string | null
  createdAt: Date | string
}

interface GroupedClient {
  id: string
  name: string
  maxUsername: string | null
  items: InboxItemLite[]
}

interface Props {
  client: GroupedClient
  reasonLabels: Record<InboxItemReason, string>
  reasonColors: Record<InboxItemReason, string>
}

export function ClientReadGroup({ client, reasonLabels, reasonColors }: Props) {
  const [expanded, setExpanded] = useState(false)
  const latest = client.items[0]
  const multiple = client.items.length > 1

  return (
    <div
      className="rounded-2xl bg-surface border border-border overflow-hidden"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      {/* Шапка-карточка: клик ведёт к latest, либо expand если >1 */}
      <div className="flex items-stretch">
        <Link
          href={`/inbox/${latest.id}`}
          className="flex-1 min-w-0 p-4 hover:bg-bg/30 transition-colors"
        >
          <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-base truncate flex items-center gap-1.5">
                {client.name}
                {client.maxUsername && (
                  <span title="Есть MAX-аккаунт" className="text-info-fg text-xs">●</span>
                )}
              </p>
              <p className="text-xs text-fg-subtle mt-0.5">
                {formatDateShort(new Date(latest.createdAt))}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {multiple && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-pill bg-bg text-fg-muted text-xs font-medium">
                  {client.items.length} тредов
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
        {multiple && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Свернуть' : 'Развернуть'}
            className="w-12 flex items-center justify-center border-l border-border hover:bg-bg/30 transition-colors text-fg-muted"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        )}
      </div>

      {/* Expand: список других тредов */}
      {expanded && multiple && (
        <ul className="border-t border-border divide-y divide-border">
          {client.items.slice(1).map((item) => (
            <li key={item.id}>
              <Link
                href={`/inbox/${item.id}`}
                className="block px-4 py-2.5 hover:bg-bg/30 transition-colors"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
                  <p className="text-xs text-fg-subtle">{formatDateShort(new Date(item.createdAt))}</p>
                  <span className={cn('inline-flex items-center px-2 py-0.5 rounded-pill text-[10px] font-medium', reasonColors[item.reason])}>
                    {reasonLabels[item.reason]}
                  </span>
                </div>
                <p className="text-sm text-fg-muted line-clamp-1">
                  {item.clientMessage || item.humanReason || '(пусто)'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
