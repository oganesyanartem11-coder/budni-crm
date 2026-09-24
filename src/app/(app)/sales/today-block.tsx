'use client'

import { useId, useState } from 'react'
import Link from 'next/link'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { PipelineBadge } from '@/components/sales/pipeline-badge'
import { CARD_CLASS, ICON_BUTTON } from '@/components/sales/styles'
import { isOverdue, taskHeadline } from '@/components/sales/utils'
import { leadDisplayName } from '@/lib/sales/labels'
import type { SalesToday, SalesTodayLead, SalesTodayTask } from '@/lib/sales/types'
import { formatAgoRu, formatDueRelative } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'

/**
 * Sprint 8.0 «Продажи»: блок «Сегодня» на /sales — три раскрываемые строки
 * (просрочено / на сегодня / без следующего шага). Пустые строки скрыты,
 * весь блок скрыт, если делать нечего.
 */

type GroupKey = 'overdue' | 'today' | 'noNextStep'
type Tone = 'danger' | 'info' | 'warning'

const TONE_BADGE: Record<Tone, string> = {
  danger: 'bg-danger-bg text-danger-fg',
  info: 'bg-info-bg text-info-fg',
  warning: 'bg-warning-bg text-warning-fg',
}

interface TodayBlockProps {
  today: SalesToday
  now: Date
  onComplete: (taskId: string) => void
  pendingTaskId: string | null
}

export function TodayBlock({ today, now, onComplete, pendingTaskId }: TodayBlockProps) {
  const { counts } = today
  const [open, setOpen] = useState<GroupKey | null>(() =>
    counts.overdue > 0 ? 'overdue' : counts.today > 0 ? 'today' : null
  )

  if (counts.overdue + counts.today + counts.noNextStep === 0) return null

  function toggle(key: GroupKey) {
    setOpen((prev) => (prev === key ? null : key))
  }

  return (
    <section aria-labelledby="sales-today-title" className={cn(CARD_CLASS, 'overflow-hidden p-0 sm:p-0')}>
      <h2 id="sales-today-title" className="px-4 pt-4 pb-1 font-display text-base font-bold text-fg-strong">
        Сегодня
      </h2>
      <div className="divide-y divide-border">
        {counts.overdue > 0 && (
          <TodayGroup
            title="Просрочено"
            count={counts.overdue}
            shown={today.overdue.length}
            tone="danger"
            open={open === 'overdue'}
            onToggle={() => toggle('overdue')}
          >
            {today.overdue.map((task) => (
              <TodayTaskRow
                key={task.id}
                task={task}
                now={now}
                onComplete={onComplete}
                pendingTaskId={pendingTaskId}
              />
            ))}
          </TodayGroup>
        )}
        {counts.today > 0 && (
          <TodayGroup
            title="На сегодня"
            count={counts.today}
            shown={today.today.length}
            tone="info"
            open={open === 'today'}
            onToggle={() => toggle('today')}
          >
            {today.today.map((task) => (
              <TodayTaskRow
                key={task.id}
                task={task}
                now={now}
                onComplete={onComplete}
                pendingTaskId={pendingTaskId}
              />
            ))}
          </TodayGroup>
        )}
        {counts.noNextStep > 0 && (
          <TodayGroup
            title="Без следующего шага"
            count={counts.noNextStep}
            shown={today.noNextStep.length}
            tone="warning"
            open={open === 'noNextStep'}
            onToggle={() => toggle('noNextStep')}
          >
            {today.noNextStep.map((lead) => (
              <TodayLeadRow key={lead.id} lead={lead} now={now} />
            ))}
          </TodayGroup>
        )}
      </div>
    </section>
  )
}

function TodayGroup({
  title,
  count,
  shown,
  tone,
  open,
  onToggle,
  children,
}: {
  title: string
  count: number
  shown: number
  tone: Tone
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const panelId = useId()
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset motion-reduce:transition-none [touch-action:manipulation]"
      >
        <span className="min-w-0 flex-1 text-sm font-semibold text-fg">{title}</span>
        <span
          className={cn(
            'inline-flex min-w-7 items-center justify-center rounded-pill px-2 py-0.5 text-sm font-bold tabular-nums',
            TONE_BADGE[tone]
          )}
        >
          {count}
        </span>
        <ChevronDown
          className={cn(
            'size-5 shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none',
            open && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </button>
      <div id={panelId} hidden={!open}>
        <ul className="divide-y divide-border-subtle border-t border-border-subtle">{children}</ul>
        {count > shown && <p className="px-4 py-2 text-xs text-fg-muted">и ещё {count - shown}</p>}
      </div>
    </div>
  )
}

/**
 * Строка задачи: stretched-link на заявку (::after на всю строку) + кнопка
 * «Выполнено» поверх (relative z-10). Никаких вложенных <a>/<button>.
 */
function TodayTaskRow({
  task,
  now,
  onComplete,
  pendingTaskId,
}: {
  task: SalesTodayTask
  now: Date
  onComplete: (taskId: string) => void
  pendingTaskId: string | null
}) {
  const { title, typeLabel } = taskHeadline(task)
  const overdue = isOverdue(task.dueAt, now)
  const pending = pendingTaskId === task.id

  return (
    <li className="relative flex items-center gap-3 px-4 py-2 transition-colors hover:bg-surface-2 has-[a:focus-visible]:bg-surface-2 motion-reduce:transition-none">
      <div className="min-w-0 flex-1">
        <Link
          href={`/sales/${task.lead.id}`}
          className="block truncate text-sm font-semibold text-fg after:absolute after:inset-0 after:content-[''] focus-visible:outline-none [touch-action:manipulation]"
        >
          {leadDisplayName(task.lead)}
        </Link>
        <p className="truncate text-sm text-fg-muted">
          {title}
          {typeLabel && ` · ${typeLabel}`} ·{' '}
          <span className={cn(overdue && 'font-medium text-danger-fg')}>
            {formatDueRelative(task.dueAt, now)}
          </span>
        </p>
      </div>
      <button
        type="button"
        aria-label={`Выполнено: ${title}`}
        title="Выполнено"
        disabled={pendingTaskId !== null}
        onClick={() => onComplete(task.id)}
        className={cn(ICON_BUTTON, 'relative z-10 text-success-fg hover:text-success-fg')}
      >
        {pending ? (
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        ) : (
          <Check className="size-5" strokeWidth={2.5} aria-hidden="true" />
        )}
      </button>
    </li>
  )
}

function TodayLeadRow({ lead, now }: { lead: SalesTodayLead; now: Date }) {
  return (
    <li className="relative flex min-h-12 items-center gap-3 px-4 py-2 transition-colors hover:bg-surface-2 has-[a:focus-visible]:bg-surface-2 motion-reduce:transition-none">
      <div className="min-w-0 flex-1">
        <Link
          href={`/sales/${lead.id}`}
          className="block truncate text-sm font-semibold text-fg after:absolute after:inset-0 after:content-[''] focus-visible:outline-none [touch-action:manipulation]"
        >
          {leadDisplayName(lead)}
        </Link>
        <p className="truncate text-xs text-fg-muted">Обновлено {formatAgoRu(lead.lastActivityAt, now)}</p>
      </div>
      <PipelineBadge status={lead.pipelineStatus} />
    </li>
  )
}
