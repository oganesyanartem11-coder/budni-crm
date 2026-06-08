import { Clock } from 'lucide-react'
import {
  getCutoffMoment,
  getCountdownToMoment,
  formatMskTime,
  CUTOFF_HOUR_MSK,
} from '@/lib/orders/cutoff'
import { listPendingCutoffData } from '@/lib/db/queries/orders'
import { cn } from '@/lib/utils/cn'

/**
 * Cut-off дня — отдельная информационная карточка под Финансами (Bug 7.24-5).
 *
 * Спринт 7.40: per-location cut-off. Раньше показывали хардкод "16:00 МСК" и
 * единый getCutoffCountdown(). Теперь берём pending PENDING_CONFIRMATION заказы
 * на сегодня+завтра (listPendingCutoffData), считаем момент cut-off ДЛЯ КАЖДОГО
 * по настройкам его локации (cutoffHourMsk/Minute, sameDayDelivery) и показываем
 * отсчёт до БЛИЖАЙШЕГО ещё не наступившего.
 *
 * Async server component — расчёт в МСК; страница force-dynamic.
 * НЕ меняет формулу cut-off, только источник данных и отображение.
 */
export async function CutOffBlock() {
  const pending = await listPendingCutoffData()
  const now = new Date()

  // Момент cut-off для каждого pending-заказа по настройкам его локации.
  const moments = pending.map((o) =>
    getCutoffMoment(
      o.deliveryDate,
      o.location.cutoffHourMsk ?? CUTOFF_HOUR_MSK,
      o.location.cutoffMinuteMsk ?? 0,
      o.location.sameDayDelivery,
    ),
  )

  // Ближайший ещё не наступивший момент (min среди тех, что > now).
  const future = moments.filter((m) => m.getTime() > now.getTime())
  const target =
    future.length > 0
      ? future.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b))
      // Все cut-off прошли → берём последний прошедший для ветки "закрыт".
      : moments.length > 0
        ? moments.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b))
        : null

  // Edge-case «нет pending заказов»: нейтральный fallback без напряжённости.
  if (!target) {
    return (
      <section
        className="rounded-3xl border border-border bg-surface p-6"
        style={{ boxShadow: 'var(--shadow-card)' }}
        aria-label="Приём заявок дня"
      >
        <div className="flex items-center gap-3">
          <span
            className="flex shrink-0 items-center justify-center rounded-2xl bg-surface-2 p-2.5 text-fg-subtle"
            aria-hidden="true"
          >
            <Clock className="size-5" strokeWidth={2} />
          </span>

          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">
              Приём заявок
            </p>
            <p className="mt-0.5 text-sm font-medium text-fg-subtle">
              Нет заказов, ожидающих приёма
            </p>
          </div>
        </div>
      </section>
    )
  }

  const countdown = getCountdownToMoment(target, now)
  const mskTime = formatMskTime(target)

  return (
    <section
      className="rounded-3xl border border-border bg-surface p-6"
      style={{ boxShadow: 'var(--shadow-card)' }}
      aria-label="Приём заявок дня"
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex shrink-0 items-center justify-center rounded-2xl p-2.5',
            countdown.isPast ? 'bg-surface-2 text-fg-subtle' : 'bg-data-amount-bg text-data-amount-ink',
          )}
          aria-hidden="true"
        >
          <Clock className="size-5" strokeWidth={2} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">
            Приём заявок
          </p>
          {countdown.isPast ? (
            <p className="mt-0.5 text-sm font-medium text-fg-subtle">
              Приём закрыт сегодня · приём заказов до {mskTime} МСК
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-fg">
              До закрытия приёма заказов{' '}
              <b className="font-bold tabular-nums text-data-amount-ink">
                {countdown.hoursLeft}ч {countdown.minutesLeft}мин
              </b>{' '}
              <span className="text-fg-muted">· {mskTime} МСК</span>
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
