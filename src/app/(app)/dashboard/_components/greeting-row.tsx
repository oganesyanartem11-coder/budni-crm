import Link from 'next/link'
import { Bell } from 'lucide-react'
import { format as fnsFormat } from 'date-fns'
import { ru } from 'date-fns/locale'
import { getGreeting } from '@/lib/utils/greeting'
import { formatTime } from '@/lib/utils/format'

interface GreetingRowProps {
  userName: string
  hasUnreadInbox: boolean
}

/**
 * Шапка дашборда: слева дата + приветствие, справа колокол «Уведомления»
 * со ссылкой в /inbox и pulse-точкой при непрочитанных.
 *
 * Server component — приветствие/дата считаются на сервере (страница должна
 * быть force-dynamic, иначе значение застынет на SSG). Pulse — чистый CSS
 * (animate-pulse), 'use client' не нужен.
 *
 * Дату собираем из date-fns ru напрямую (а не formatDateLong) — нужен формат
 * «чт · 7 мая» без года и запятой после дня недели; uppercase даёт «ЧТ · 7 МАЯ».
 */
export function GreetingRow({ userName, hasUnreadInbox }: GreetingRowProps) {
  const now = new Date()
  const dayAndDate = fnsFormat(now, 'EEEEEE · d MMMM', { locale: ru })
  const caption = `${dayAndDate} · ${formatTime(now)}`

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wider text-fg-muted">
          {caption}
        </p>
        <h1 className="mt-0.5 font-display text-2xl font-extrabold text-fg sm:text-3xl">
          {getGreeting()}, {userName}
        </h1>
      </div>

      <Link
        href="/inbox"
        aria-label={
          hasUnreadInbox ? 'Уведомления, есть непрочитанные' : 'Уведомления'
        }
        className="relative flex size-9 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-fg-muted outline-none transition-colors [touch-action:manipulation] hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <Bell className="size-[15px]" strokeWidth={2} aria-hidden="true" />
        {hasUnreadInbox && (
          <span
            className="absolute right-2.5 top-2.5 size-2 animate-pulse rounded-full bg-brand-orange motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
      </Link>
    </div>
  )
}
