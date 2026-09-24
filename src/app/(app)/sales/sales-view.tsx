'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Handshake, Loader2, Search, SearchX, TriangleAlert, X } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { PhoneLink } from '@/components/ui/phone-link'
import { PipelineBadge } from '@/components/sales/pipeline-badge'
import { INPUT_CLASS, META_CHIP } from '@/components/sales/styles'
import { useTaskCompletion } from '@/components/sales/use-task-completion'
import { isOverdue } from '@/components/sales/utils'
import {
  LEAD_FILTERS,
  TASK_TYPE_RU,
  formTypeLabel,
  isActiveStatus,
  sourceLabel,
  type LeadFilter,
} from '@/lib/sales/labels'
import type { LeadListItem, SalesToday } from '@/lib/sales/types'
import { formatAgoRu, formatDueRelative } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import { TodayBlock } from './today-block'

/**
 * Sprint 8.0 «Продажи»: клиентская часть /sales — блок «Сегодня», фильтр-чипы,
 * поиск и список заявок. Всё относительное время считается от `now` сервера.
 */

interface SalesViewProps {
  today: SalesToday
  leads: LeadListItem[]
  filter: LeadFilter
  q: string
  now: Date
}

const LIST_LIMIT = 200

function salesHref(filter: LeadFilter, q: string): string {
  const sp = new URLSearchParams()
  if (filter !== 'active') sp.set('filter', filter)
  if (q) sp.set('q', q)
  const qs = sp.toString()
  return qs ? `/sales?${qs}` : '/sales'
}

export function SalesView({ today, leads, filter, q, now }: SalesViewProps) {
  const { complete, pendingTaskId, dialog } = useTaskCompletion()

  return (
    <div className="space-y-4">
      <TodayBlock today={today} now={now} onComplete={complete} pendingTaskId={pendingTaskId} />

      <div className="space-y-3">
        <LeadFilterBar filter={filter} q={q} />
        <LeadSearch filter={filter} q={q} />
      </div>

      <LeadList leads={leads} now={now} filter={filter} q={q} />

      {dialog}
    </div>
  )
}

// ---------- Фильтр-чипы ----------

function LeadFilterBar({ filter, q }: { filter: LeadFilter; q: string }) {
  return (
    <nav
      aria-label="Фильтр заявок"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden"
    >
      {LEAD_FILTERS.map((f) => {
        const active = f.value === filter
        return (
          <Link
            key={f.value}
            href={salesHref(f.value, q)}
            scroll={false}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-11 shrink-0 items-center rounded-pill px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors motion-reduce:transition-none [touch-action:manipulation]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              active
                ? 'bg-primary text-primary-foreground shadow-[var(--shadow-capsule)]'
                : 'border border-border bg-surface text-fg hover:bg-surface-2'
            )}
          >
            {f.label}
          </Link>
        )
      })}
    </nav>
  )
}

// ---------- Поиск (?q=, debounce 300 мс, Enter — сразу) ----------

function LeadSearch({ filter, q }: { filter: LeadFilter; q: string }) {
  const router = useRouter()
  const [value, setValue] = useState(q)
  const [isPending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Что мы сами последним положили в URL: чтобы ответный q не затирал
  // символы, набранные пока шла навигация.
  const lastPushedRef = useRef(q)
  const filterRef = useRef(filter)

  useEffect(() => {
    filterRef.current = filter
  }, [filter])

  // Внешняя смена q (назад/вперёд в браузере) — синхронизируем поле.
  useEffect(() => {
    if (q !== lastPushedRef.current) {
      lastPushedRef.current = q
      setValue(q)
    }
  }, [q])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  function push(next: string) {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const trimmed = next.trim().slice(0, 100)
    if (trimmed === lastPushedRef.current) return
    lastPushedRef.current = trimmed
    startTransition(() => {
      router.replace(salesHref(filterRef.current, trimmed), { scroll: false })
    })
  }

  function handleChange(next: string) {
    setValue(next)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => push(next), 300)
  }

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        push(value)
        inputRef.current?.blur()
      }}
      className="relative"
    >
      <label htmlFor="sales-search" className="sr-only">
        Поиск заявок
      </label>
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle"
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        id="sales-search"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Имя, компания или телефон"
        className={cn(INPUT_CLASS, 'pr-12 pl-9 [&::-webkit-search-cancel-button]:hidden')}
      />
      <span className="absolute top-1/2 right-0 flex -translate-y-1/2 items-center">
        {isPending ? (
          <span className="inline-flex min-h-11 min-w-11 items-center justify-center text-fg-subtle">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <span className="sr-only">Ищем…</span>
          </span>
        ) : value ? (
          <button
            type="button"
            aria-label="Очистить поиск"
            onClick={() => {
              setValue('')
              push('')
            }}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-pill text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [touch-action:manipulation]"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </span>
    </form>
  )
}

// ---------- Список ----------

function LeadList({
  leads,
  now,
  filter,
  q,
}: {
  leads: LeadListItem[]
  now: Date
  filter: LeadFilter
  q: string
}) {
  if (leads.length === 0) {
    if (q) {
      return (
        <EmptyState
          icon={SearchX}
          title="Ничего не нашлось"
          description={`По запросу «${q}» заявок нет. Проверь написание или смени фильтр.`}
          className="px-6 py-10"
        />
      )
    }
    return (
      <EmptyState
        icon={Handshake}
        title="Заявок нет"
        description={
          filter === 'active'
            ? 'Заведи первую или дождись с сайта'
            : 'В этом фильтре пусто. Заведи заявку или дождись с сайта'
        }
        className="px-6 py-10"
      />
    )
  }

  return (
    <section aria-label="Заявки" className="space-y-2">
      <p className="px-1 text-sm text-fg-muted">
        Заявок: {leads.length}
        {leads.length >= LIST_LIMIT && ' — показаны первые, уточни поиск'}
      </p>
      <ul className="space-y-2">
        {leads.map((lead) => (
          <LeadRow key={lead.id} lead={lead} now={now} />
        ))}
      </ul>
    </section>
  )
}

/**
 * Карточка заявки. Вся карточка кликабельна через stretched-link (::after у
 * ссылки с именем растянут на карточку), а телефон — отдельная ссылка tel:
 * поверх (relative z-10). Ссылки — соседи, не вложены друг в друга.
 */
function LeadRow({ lead, now }: { lead: LeadListItem; now: Date }) {
  const company = lead.company?.trim() || null
  const name = lead.name?.trim() || null
  const primary = company || name || lead.phone
  const secondary = company && name ? name : null
  const source = sourceLabel(lead.source)
  const task = lead.nextTask
  const overdue = task ? isOverdue(task.dueAt, now) : false
  const noNextStep = !task && isActiveStatus(lead.pipelineStatus) && !lead.archivedAt

  return (
    <li
      className={cn(
        'relative rounded-2xl border border-border bg-surface p-4 shadow-card transition-colors hover:bg-surface-2 motion-reduce:transition-none',
        'has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-primary/40'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link
            href={`/sales/${lead.id}`}
            className="block truncate font-display text-base font-semibold text-fg after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none [touch-action:manipulation]"
          >
            {primary}
          </Link>
          {secondary && <p className="truncate text-sm text-fg-muted">{secondary}</p>}
        </div>
        <PipelineBadge status={lead.pipelineStatus} />
      </div>

      <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
        <span className={META_CHIP}>
          <span className="truncate">{formTypeLabel(lead.formType)}</span>
        </span>
        {source && (
          <span className={META_CHIP}>
            <span className="truncate">{source}</span>
          </span>
        )}
        {lead.archivedAt && <span className={META_CHIP}>В архиве</span>}
      </div>

      {task ? (
        <p className={cn('mt-2 truncate text-sm', overdue ? 'font-medium text-danger-fg' : 'text-fg')}>
          → {TASK_TYPE_RU[task.type]} · {formatDueRelative(task.dueAt, now)}
        </p>
      ) : noNextStep ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-danger-fg">
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          Нет следующего шага
        </p>
      ) : null}

      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-fg-muted">
          Обновлено {formatAgoRu(lead.lastActivityAt, now)}
        </span>
        {/* Телефон поверх stretched-link: тап звонит, а не открывает карточку. */}
        <span className="relative z-10 -mr-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          <PhoneLink
            phone={lead.phone}
            className="inline-flex min-h-11 items-center rounded-pill px-2 text-sm font-medium text-fg tabular-nums [touch-action:manipulation]"
          />
        </span>
      </div>
    </li>
  )
}
