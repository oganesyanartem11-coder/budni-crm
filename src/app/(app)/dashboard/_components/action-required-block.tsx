import Link from 'next/link'
import { Clock, ChevronRight } from 'lucide-react'
import { countPendingConfirmationToday } from '@/lib/db/queries/orders'
import { getCutoffCountdown } from '@/lib/orders/cutoff'

/**
 * «Требует действия» — баннер на дашборде про DYNAMIC-заказы, ждущие
 * подтверждения, с обратным отсчётом до cut-off (16:00 МСК).
 *
 * Async server component: сам тянет счётчик. Если ждущих нет (n === 0) —
 * не рендерится вовсе (return null), чтобы не загромождать дашборд.
 *
 * «DYNAMIC» — тип заказа, по-русски не склоняется, оставлено как есть.
 */
export async function ActionRequiredBlock() {
  const n = await countPendingConfirmationToday()
  if (n === 0) return null

  // Без аргументов → cut-off сегодняшнего дня 16:00 МСК.
  const countdown = getCutoffCountdown()

  return (
    <Link
      href="/orders/confirm"
      className="flex items-center gap-3 rounded-xl border border-brand-yellow-light bg-linear-to-br from-brand-yellow-light to-surface p-4 outline-none transition-shadow [touch-action:manipulation] focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span
        className="flex shrink-0 items-center justify-center rounded-lg bg-surface p-2 text-brand-yellow"
        aria-hidden="true"
      >
        <Clock className="size-5" strokeWidth={2} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-bold uppercase tracking-wider text-warning-fg">
          Требует действия
        </p>
        <p className="mt-0.5 text-sm text-fg-muted">
          <b className="font-bold text-brand-orange-dark">{n} DYNAMIC</b> ждут ·{' '}
          {countdown.isPast ? (
            <>cut-off прошёл</>
          ) : (
            <>
              cut-off через{' '}
              <b className="font-bold tabular-nums text-fg">
                {countdown.hoursLeft}ч {countdown.minutesLeft}мин
              </b>
            </>
          )}
        </p>
      </div>

      <ChevronRight className="size-5 shrink-0 text-fg-subtle" aria-hidden="true" />
    </Link>
  )
}
