import { Clock } from 'lucide-react'
import { getCutoffCountdown } from '@/lib/orders/cutoff'
import { cn } from '@/lib/utils/cn'

/**
 * Cut-off дня (16:00 МСК) — отдельная информационная карточка под Финансами
 * (Bug 7.24-5). Раньше отсчёт жил только внутри ActionRequiredBlock (и то лишь
 * когда есть DYNAMIC-заказы к подтверждению). Здесь — постоянный статус дня,
 * не завязанный на наличие заказов.
 *
 * Server component — getCutoffCountdown() считает в МСК; страница force-dynamic.
 * НЕ меняет расчёт cut-off, только отображение.
 */
export function CutOffBlock() {
  const countdown = getCutoffCountdown()

  return (
    <section
      className="rounded-3xl border border-border bg-surface p-6"
      style={{ boxShadow: 'var(--shadow-card)' }}
      aria-label="Cut-off дня"
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
            Cut-off
          </p>
          {countdown.isPast ? (
            <p className="mt-0.5 text-sm font-medium text-fg-subtle">
              Cut-off закрыт сегодня · приём заказов до 16:00 МСК
            </p>
          ) : (
            <p className="mt-0.5 text-sm text-fg">
              До закрытия приёма заказов{' '}
              <b className="font-bold tabular-nums text-data-amount-ink">
                {countdown.hoursLeft}ч {countdown.minutesLeft}мин
              </b>{' '}
              <span className="text-fg-muted">· 16:00 МСК</span>
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
