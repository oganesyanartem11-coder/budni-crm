import Link from 'next/link'
import { getGreeting } from '@/lib/utils/greeting'
import {
  formatMskWeekdayShort,
  formatMskDayMonth,
  formatMskTime,
} from '@/lib/utils/format'

interface GreetingRowProps {
  userName: string
  hasUnreadInbox: boolean
}

/**
 * Шапка дашборда: слева дата + приветствие, справа — аватар профиля
 * (кружок с инициалом) со ссылкой в /more.
 *
 * Server component — приветствие/дата считаются на сервере (страница должна
 * быть force-dynamic, иначе значение застынет на SSG).
 *
 * Дата/время — через MSK-форматтеры (formatMsk*), НЕ через date-fns: на Vercel
 * сервер в UTC, date-fns форматировал бы время на −3ч (Bug 7.24-3). uppercase
 * даёт «ВС · 31 МАЯ · 21:39» из CSS-класса.
 *
 * Bug 7.24-1: раньше тут был колокол со ссылкой в /inbox — бесполезен (inbox
 * уже в навигации). Заменён на аватар профиля → /more. Непрочитанные показываем
 * маленькой точкой на аватаре.
 */
export function GreetingRow({ userName, hasUnreadInbox }: GreetingRowProps) {
  const now = new Date()
  const caption = `${formatMskWeekdayShort(now)} · ${formatMskDayMonth(now)} · ${formatMskTime(now)}`
  const initial = userName.trim()[0]?.toUpperCase() ?? 'А'

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
        href="/more"
        aria-label={hasUnreadInbox ? 'Профиль, есть непрочитанные' : 'Профиль'}
        className="relative flex size-11 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full bg-data-revenue-bg text-data-revenue-ink text-base font-bold outline-none transition-opacity [touch-action:manipulation] hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {initial}
        {hasUnreadInbox && (
          <span
            className="absolute right-0 top-0 size-2.5 rounded-full bg-brand-orange ring-2 ring-bg"
            aria-hidden="true"
          />
        )}
      </Link>
    </div>
  )
}
