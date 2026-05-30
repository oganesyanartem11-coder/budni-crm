import Link from 'next/link'
import { CheckCircle2, Circle, ChevronRight } from 'lucide-react'
import { getOnboardingStatus, type ClientForOnboarding } from '@/lib/clients/onboarding'
import { cn } from '@/lib/utils/cn'

export function OnboardingChecklist({ client }: { client: ClientForOnboarding }) {
  const status = getOnboardingStatus(client)

  if (status.isComplete) {
    return (
      <div
        className="rounded-xl bg-success-bg border border-success/20 p-4 mb-5 flex items-center gap-2"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
        <p className="text-sm font-medium text-fg">Клиент полностью настроен</p>
      </div>
    )
  }

  return (
    <div
      className="rounded-xl bg-surface border border-border p-4 mb-5"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="font-display text-xs uppercase tracking-wider text-fg-muted font-bold">
          Онбординг
        </h3>
        <p className="text-xs text-fg-muted tabular-nums">
          {status.doneCount} из {status.totalCount}
        </p>
      </div>
      <ul className="divide-y divide-border">
        {status.steps.map((s) => (
          <li key={s.key} className="flex items-center gap-3 py-2.5">
            {s.done ? (
              <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
            ) : (
              <Circle className="w-4 h-4 text-fg-subtle shrink-0" />
            )}
            <span
              className={cn(
                'flex-1 text-sm',
                s.done ? 'text-fg-muted line-through' : 'text-fg'
              )}
            >
              {s.label}
            </span>
            {!s.done && s.actionHref && (
              <Link
                href={s.actionHref}
                style={{ touchAction: 'manipulation' }}
                className="text-xs font-medium text-brand-green hover:text-brand-green-deep flex items-center gap-0.5 group rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                Настроить
                <ChevronRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
