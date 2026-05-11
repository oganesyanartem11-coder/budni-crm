'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Inbox as InboxIcon, MessageSquare } from 'lucide-react'
import { formatDateShort, formatTime } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import { fetchInboxListFresh, type InboxClientCard } from './actions'

const POLL_INTERVAL_MS = 10_000

export function InboxList({ initialItems }: { initialItems: InboxClientCard[] }) {
  const [items, setItems] = useState(initialItems)

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const refetch = async () => {
      const fresh = await fetchInboxListFresh()
      if (fresh) setItems(fresh)
    }

    const startPolling = () => {
      if (timer) return
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') refetch()
      }, POLL_INTERVAL_MS)
    }
    const stopPolling = () => {
      if (timer) { clearInterval(timer); timer = null }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refetch()
        startPolling()
      } else {
        stopPolling()
      }
    }

    if (document.visibilityState === 'visible') startPolling()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopPolling()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  if (items.length === 0) {
    return (
      <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
        <InboxIcon className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
        <p className="font-medium text-fg mb-1">Переписки нет</p>
        <p className="text-sm">Когда клиенты начнут писать боту, они появятся здесь.</p>
      </div>
    )
  }

  const totalUnread = items.reduce((s, c) => s + c.unreadCount, 0)

  return (
    <div>
      <p className="text-sm text-fg-muted mb-3">
        Клиентов: {items.length}
        {totalUnread > 0 && <span className="text-danger-fg font-medium"> · {totalUnread} непрочитанных</span>}
      </p>
      <div className="space-y-2">
        {items.map((c) => (
          <ClientRow key={c.clientId} card={c} />
        ))}
      </div>
    </div>
  )
}

function ClientRow({ card }: { card: InboxClientCard }) {
  const hasUnread = card.unreadCount > 0
  const lastDate = card.lastMessage ? new Date(card.lastMessage.createdAt) : null
  const now = Date.now()
  const sameDay = lastDate
    ? new Date(lastDate).toDateString() === new Date(now).toDateString()
    : false

  const preview = card.lastMessage
    ? formatPreview(card.lastMessage.text, card.lastMessage.direction)
    : null

  const href = card.latestInboxItemId ? `/inbox/${card.latestInboxItemId}` : null

  const card_inner = (
    <div
      className={cn(
        'rounded-2xl bg-surface border p-4 transition-all',
        href && 'hover:border-border-strong cursor-pointer',
        !href && 'opacity-70 cursor-not-allowed',
        hasUnread && href ? 'border-info/30' : 'border-border',
      )}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-base truncate flex items-center gap-1.5">
            {card.clientName}
            {card.maxUsername && (
              <span title="Есть MAX-аккаунт" className="text-info-fg text-xs">●</span>
            )}
            {hasUnread && (
              <span className="ml-1 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-danger text-accent-fg text-[10px] font-bold">
                {card.unreadCount > 9 ? '9+' : card.unreadCount}
              </span>
            )}
          </p>
        </div>
        {lastDate && (
          <p className="text-xs text-fg-subtle shrink-0">
            {sameDay ? formatTime(lastDate) : formatDateShort(lastDate)}
          </p>
        )}
      </div>
      {preview ? (
        <p className={cn('text-sm line-clamp-1', hasUnread ? 'text-fg' : 'text-fg-muted')}>
          {preview}
        </p>
      ) : (
        <p className="text-sm text-fg-subtle italic">Нет сообщений</p>
      )}
      {!href && (
        <p className="text-xs text-fg-subtle mt-1 flex items-center gap-1">
          <MessageSquare className="w-3 h-3" />
          Нет активного обращения
        </p>
      )}
    </div>
  )

  if (!href) return card_inner

  return <Link href={href}>{card_inner}</Link>
}

function formatPreview(text: string, direction: 'IN' | 'OUT' | 'MANAGER_OUT'): string {
  const prefix =
    direction === 'IN' ? '' :
    direction === 'OUT' ? 'Бот: ' :
    'Вы: '
  return prefix + text
}
