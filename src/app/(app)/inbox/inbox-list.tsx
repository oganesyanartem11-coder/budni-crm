'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Inbox as InboxIcon } from 'lucide-react'
import { formatDateShort, formatTime } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import { fetchInboxListFresh, type InboxClientCard } from './actions'
import { ToneChip } from '@/components/inbox/ToneChip'
import type { ToneLabel } from '@/lib/inbox/tone-labels'

const POLL_INTERVAL_MS = 10_000

interface Props {
  initialItems: InboxClientCard[]
  activeTone?: ToneLabel
}

export function InboxList({ initialItems, activeTone }: Props) {
  const [items, setItems] = useState(initialItems)
  const scrollAnchorRef = useRef<{ y: number; offsetTop: number; cardId: string | null }>({
    y: 0, offsetTop: 0, cardId: null,
  })

  // При смене URL-фильтра ?tone= серверный page перерендерит и пришлёт новый
  // initialItems. Без этого sync polling-стейт остался бы со старыми items
  // до первого poll-цикла, и пользователь видел бы старый набор карточек.
  useEffect(() => {
    setItems(initialItems)
  }, [initialItems])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const refetch = async () => {
      // Smart-scroll: перед обновлением запоминаем top первой видимой карточки
      // в окне. После замены items находим её по data-client-id и компенсируем
      // дельту высоты — пользователь видит ту же карточку на той же позиции.
      const visibleEl = findFirstVisibleCard()
      if (visibleEl) {
        scrollAnchorRef.current = {
          y: window.scrollY,
          offsetTop: visibleEl.getBoundingClientRect().top,
          cardId: visibleEl.dataset.clientId ?? null,
        }
      }
      const fresh = await fetchInboxListFresh(activeTone)
      if (!fresh) return
      setItems(fresh)
      requestAnimationFrame(() => {
        const anchor = scrollAnchorRef.current
        if (!anchor.cardId) return
        const el = document.querySelector<HTMLElement>(`[data-client-id="${anchor.cardId}"]`)
        if (!el) return
        const newTop = el.getBoundingClientRect().top
        const delta = newTop - anchor.offsetTop
        window.scrollBy({ top: delta, left: 0, behavior: 'auto' })
      })
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
  }, [activeTone])

  if (items.length === 0) {
    return (
      <div
        className="w-full rounded-3xl bg-surface border border-border p-12 flex flex-col items-center justify-center text-center text-fg-muted min-h-[400px]"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <InboxIcon className="w-12 h-12 text-fg-subtle mb-4" strokeWidth={1.5} />
        <p className="font-medium text-fg mb-1">Переписки нет</p>
        <p className="text-sm max-w-sm">Когда клиенты начнут писать боту, они появятся здесь.</p>
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

  return (
    <Link
      href={`/inbox/${card.clientId}`}
      data-client-id={card.clientId}
      className="block [touch-action:manipulation] rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <div
        className={cn(
          'min-h-11 rounded-xl bg-surface border border-border p-4 transition-colors hover:bg-surface-2 cursor-pointer',
          hasUnread && 'border-l-4 border-l-brand-green bg-brand-green-light/40',
        )}
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <div className="min-w-0 flex-1">
            <p className="font-display font-semibold text-base truncate flex items-center gap-1.5 flex-wrap">
              <span className="truncate">{card.clientName}</span>
              {card.maxUsername && (
                <span title="Есть MAX-аккаунт" className="text-info-fg text-xs">●</span>
              )}
              {card.latestTone && <ToneChip tone={card.latestTone} size="sm" />}
              {hasUnread && (
                <span className="ml-1 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-danger text-surface text-[10px] font-bold">
                  {card.unreadCount > 9 ? '9+' : card.unreadCount}
                </span>
              )}
            </p>
          </div>
          {lastDate && (
            <p className="text-xs text-fg-subtle tabular-nums shrink-0">
              {sameDay ? formatTime(lastDate) : formatDateShort(lastDate)}
            </p>
          )}
        </div>
        {preview ? (
          <p className={cn('text-sm line-clamp-2', hasUnread ? 'text-fg' : 'text-fg-muted')}>
            {preview}
          </p>
        ) : (
          <p className="text-sm text-fg-subtle italic">Нет сообщений</p>
        )}
      </div>
    </Link>
  )
}

function findFirstVisibleCard(): HTMLElement | null {
  const cards = document.querySelectorAll<HTMLElement>('[data-client-id]')
  for (const el of cards) {
    const rect = el.getBoundingClientRect()
    if (rect.bottom > 0 && rect.top < window.innerHeight) return el
  }
  return null
}

function formatPreview(text: string, direction: 'IN' | 'OUT' | 'MANAGER_OUT'): string {
  const prefix =
    direction === 'IN' ? '' :
    direction === 'OUT' ? 'Бот: ' :
    'Вы: '
  return prefix + text
}
