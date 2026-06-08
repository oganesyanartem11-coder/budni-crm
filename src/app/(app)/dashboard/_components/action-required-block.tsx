import Link from 'next/link'
import { Clock, ChevronRight } from 'lucide-react'
import { listPendingCutoffData } from '@/lib/db/queries/orders'
import {
  getCutoffMoment,
  getCountdownToMoment,
  formatMskTime,
} from '@/lib/orders/cutoff'

/**
 * «Требует действия» — баннер на дашборде про DYNAMIC-заказы, ждущие
 * подтверждения, с обратным отсчётом до cut-off.
 *
 * Async server component: сам тянет данные. Если ждущих нет (n === 0) —
 * не рендерится вовсе (return null), чтобы не загромождать дашборд.
 *
 * 7.40: cut-off теперь per-location. Один запрос listPendingCutoffData()
 * даёт и количество (data.length → n), и моменты cut-off по каждому заказу,
 * чтобы count и моменты не рассинхронились. Для каждого заказа момент
 * считается через getCutoffMoment(deliveryDate, hour, minute, sameDay),
 * а отсчёт показывается до БЛИЖАЙШЕГО ещё не наступившего cut-off. Если все
 * cut-off уже прошли — показываем ветку «cut-off прошёл».
 *
 * «DYNAMIC» — тип заказа, по-русски не склоняется, оставлено как есть.
 */
export async function ActionRequiredBlock() {
  const data = await listPendingCutoffData()
  const n = data.length
  if (n === 0) return null

  const now = new Date()
  const nowMs = now.getTime()

  // Момент cut-off по каждому заказу (per-location, с дефолтами 16:00).
  const moments = data.map((o) =>
    getCutoffMoment(
      o.deliveryDate,
      o.location?.cutoffHourMsk ?? 16,
      o.location?.cutoffMinuteMsk ?? 0,
      o.location?.sameDayDelivery ?? false
    )
  )

  // Ближайший ещё НЕ наступивший cut-off (минимальный timestamp среди будущих).
  const future = moments.filter((m) => m.getTime() > nowMs)
  const target =
    future.length > 0
      ? future.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b))
      : null

  // target === null → все cut-off прошли. Берём любой прошедший момент, чтобы
  // getCountdownToMoment вернул isPast (ветка «cut-off прошёл»).
  const countdown = getCountdownToMoment(target ?? now, now)

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
          {countdown.isPast || !target ? (
            <>приём закрыт</>
          ) : (
            <>
              приём через{' '}
              <b className="font-bold tabular-nums text-fg">
                {countdown.hoursLeft}ч {countdown.minutesLeft}мин
              </b>{' '}
              (к {formatMskTime(target)})
            </>
          )}
        </p>
      </div>

      <ChevronRight className="size-5 shrink-0 text-fg-subtle" aria-hidden="true" />
    </Link>
  )
}
