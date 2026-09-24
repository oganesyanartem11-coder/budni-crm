'use client'

import { useId, useState } from 'react'
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Building2,
  CalendarPlus,
  CircleCheck,
  CircleX,
  Copy,
  Inbox,
  Loader2,
  MessageSquare,
  Send,
  Trash2,
  Trophy,
  type LucideIcon,
} from 'lucide-react'
import type { SalesActivityKind } from '@prisma/client'
import { CAPSULE_PRIMARY, CARD_CLASS, SECTION_TITLE_CLASS, TEXTAREA_CLASS } from '@/components/sales/styles'
import { useSalesMutation } from '@/components/sales/use-sales-mutation'
import type { LeadDetail } from '@/lib/sales/types'
import { formatMskDateTimeShort } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import { addLeadNote } from '../actions'

const KIND_ICON: Record<SalesActivityKind, LucideIcon> = {
  INCOMING: Inbox,
  NOTE: MessageSquare,
  STATUS_CHANGE: ArrowRightLeft,
  TASK_CREATED: CalendarPlus,
  TASK_DONE: CircleCheck,
  TASK_RESCHEDULED: AlarmClock,
  TASK_DELETED: Trash2,
  DUPLICATE: Copy,
  WON: Trophy,
  LOST: CircleX,
  ARCHIVED: Archive,
  UNARCHIVED: ArchiveRestore,
  CLIENT_LINKED: Building2,
}

const KIND_TONE: Partial<Record<SalesActivityKind, string>> = {
  WON: 'bg-success-bg text-success-fg',
  CLIENT_LINKED: 'bg-success-bg text-success-fg',
  TASK_DONE: 'bg-success-bg text-success-fg',
  LOST: 'bg-danger-bg text-danger-fg',
  INCOMING: 'bg-info-bg text-info-fg',
  DUPLICATE: 'bg-warning-bg text-warning-fg',
}

/** История: заметка + лента событий (новые сверху). */
export function LeadHistory({ lead }: { lead: LeadDetail }) {
  const ids = useId()
  const { run, isPending } = useSalesMutation()
  const [text, setText] = useState('')

  function submit(e: { preventDefault(): void }) {
    e.preventDefault()
    const note = text.trim()
    if (!note || isPending) return
    run(() => addLeadNote({ leadId: lead.id, text: note }), {
      success: 'Заметка добавлена',
      onSuccess: () => setText(''),
    })
  }

  return (
    <section aria-labelledby={`${ids}-title`} className={CARD_CLASS}>
      <h2 id={`${ids}-title`} className={SECTION_TITLE_CLASS}>
        История
      </h2>

      <form onSubmit={submit} className="mt-3 flex items-end gap-2">
        <label htmlFor={`${ids}-note`} className="sr-only">
          Заметка
        </label>
        <textarea
          id={`${ids}-note`}
          rows={1}
          value={text}
          disabled={isPending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e)
          }}
          placeholder="Заметка…"
          className={cn(TEXTAREA_CLASS, 'max-h-40 min-w-0 flex-1 field-sizing-content')}
        />
        <button
          type="submit"
          disabled={isPending || !text.trim()}
          aria-label="Добавить заметку"
          className={cn(CAPSULE_PRIMARY, 'min-w-11 px-4')}
        >
          {isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="size-4" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">Добавить</span>
        </button>
      </form>

      {lead.activities.length === 0 ? (
        <p className="mt-4 text-sm text-fg-muted">Событий пока нет</p>
      ) : (
        <ol className="relative mt-4 space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[17px] before:w-px before:bg-border">
          {lead.activities.map((activity) => {
            const Icon = KIND_ICON[activity.kind] ?? MessageSquare
            const createdAt = new Date(activity.createdAt)
            return (
              <li key={activity.id} className="relative flex gap-3">
                <span
                  className={cn(
                    'relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full',
                    KIND_TONE[activity.kind] ?? 'bg-surface-2 text-fg-muted'
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1 pt-1">
                  <p className="text-sm whitespace-pre-line break-words text-fg">{activity.text}</p>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    <time dateTime={createdAt.toISOString()}>{formatMskDateTimeShort(createdAt)}</time>
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
