import { getGreeting } from '@/lib/utils/greeting'
import {
  formatMskWeekdayShort,
  formatMskDayMonth,
  formatMskTime,
} from '@/lib/utils/format'
import { ProfileMenu } from '@/components/layout/profile-menu'
import type { UserRole } from '@prisma/client'

interface GreetingRowProps {
  userName: string
  initials: string
  role: UserRole
  hasUnreadInbox: boolean
}

/**
 * Шапка дашборда: слева дата + приветствие, справа — профиль.
 *
 * Server component — дата/приветствие считаются на сервере (страница force-dynamic).
 * Дата/время через MSK-форматтеры (formatMsk*), НЕ date-fns: сервер в UTC (Bug 7.24-3).
 *
 * Bug 7.25-B: профиль-аватар теперь открывает дропдаун (ProfileMenu variant="mobile":
 * Настройки / Пользователи / Выйти) — тот же, что в sidebar footer на desktop, вместо
 * прежней навигации на /more. Показывается ТОЛЬКО на mobile (lg:hidden) — на desktop
 * профиль уже есть в footer сайдбара, дублировать не нужно. Точка непрочитанного inbox
 * сохранена поверх аватара.
 */
export function GreetingRow({ userName, initials, role, hasUnreadInbox }: GreetingRowProps) {
  const now = new Date()
  const caption = `${formatMskWeekdayShort(now)} · ${formatMskDayMonth(now)} · ${formatMskTime(now)}`

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

      <div className="relative shrink-0 lg:hidden">
        <ProfileMenu name={userName} initials={initials} role={role} variant="mobile" />
        {hasUnreadInbox && (
          <span
            className="pointer-events-none absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-brand-orange ring-2 ring-bg"
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  )
}
