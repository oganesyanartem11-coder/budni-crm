'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Building2, Check, ChevronRight, Loader2, RotateCcw, UserCheck, XCircle } from 'lucide-react'
import type { LeadPipelineStatus } from '@prisma/client'
import { CAPSULE_OUTLINE, CARD_CLASS, SECTION_TITLE_CLASS } from '@/components/sales/styles'
import { useSalesMutation } from '@/components/sales/use-sales-mutation'
import { LOST_REASON_RU, PIPELINE_STATUS_RU, PIPELINE_STEPS } from '@/lib/sales/labels'
import type { LeadDetail } from '@/lib/sales/types'
import { formatMoney, formatMskDateTimeShort } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import { changeLeadStatus } from '../actions'
import { LostDialog } from './lost-dialog'
import { WonDialog } from './won-dialog'

/**
 * Стадия заявки: горизонтальный степпер (скроллится сам, страница — нет),
 * «Стал клиентом» / «Отказ»; для WON/LOST — плашка + «Вернуть в работу».
 */
export function StageBlock({ lead }: { lead: LeadDetail }) {
  const { run, isPending } = useSalesMutation()
  const [target, setTarget] = useState<LeadPipelineStatus | null>(null)
  const [wonOpen, setWonOpen] = useState(false)
  const [lostOpen, setLostOpen] = useState(false)

  const status = lead.pipelineStatus
  const closed = status === 'WON' || status === 'LOST'

  function moveTo(next: LeadPipelineStatus, success: string) {
    if (isPending || next === status) return
    setTarget(next)
    run(() => changeLeadStatus({ leadId: lead.id, status: next }), { success })
  }

  return (
    <section aria-labelledby="lead-stage-title" className={cn(CARD_CLASS, 'overflow-hidden')}>
      <h2 id="lead-stage-title" className={SECTION_TITLE_CLASS}>
        Стадия
      </h2>

      {closed ? (
        <ClosedBanner lead={lead} />
      ) : (
        <Stepper
          status={status}
          disabled={isPending}
          pendingTarget={isPending ? target : null}
          onSelect={(step) => moveTo(step, `Стадия: ${PIPELINE_STATUS_RU[step]}`)}
        />
      )}

      <div className="mt-3 space-y-2">
        {lead.client && (
          <Link
            href={`/clients/${lead.client.id}`}
            className="flex min-h-11 items-center gap-3 rounded-xl bg-success-bg px-3 py-2 text-sm text-success-fg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [touch-action:manipulation]"
          >
            <Building2 className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              Клиент: <span className="font-semibold">{lead.client.name}</span>
            </span>
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          </Link>
        )}

        {/* Активная заявка — всегда можно закрыть. Если клиент уже привязан (вернули
            в работу после «Клиента»), «Стал клиентом» сразу ставит стадию без диалога. */}
        {!closed && (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() => (lead.client ? moveTo('WON', 'Заявка закрыта: клиент') : setWonOpen(true))}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-pill bg-success-bg px-2 py-2 text-sm font-semibold text-success-fg transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [touch-action:manipulation]"
            >
              <UserCheck className="size-4 shrink-0" aria-hidden="true" />
              Стал клиентом
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => setLostOpen(true)}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-pill bg-danger-bg px-2 py-2 text-sm font-semibold text-danger-fg transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [touch-action:manipulation]"
            >
              <XCircle className="size-4 shrink-0" aria-hidden="true" />
              Отказ
            </button>
          </div>
        )}

        {closed && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() => moveTo('IN_PROGRESS', 'Заявка снова в работе')}
              className={cn(CAPSULE_OUTLINE, 'flex-1 sm:flex-none')}
            >
              {isPending && target === 'IN_PROGRESS' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="size-4" aria-hidden="true" />
              )}
              Вернуть в работу
            </button>
            {status === 'WON' && !lead.client && (
              <button
                type="button"
                disabled={isPending}
                onClick={() => setWonOpen(true)}
                className={cn(CAPSULE_OUTLINE, 'flex-1 sm:flex-none')}
              >
                <Building2 className="size-4" aria-hidden="true" />
                Клиент в CRM
              </button>
            )}
          </div>
        )}
      </div>

      <WonDialog leadId={lead.id} dealAmount={lead.dealAmount} open={wonOpen} onOpenChange={setWonOpen} />
      <LostDialog leadId={lead.id} open={lostOpen} onOpenChange={setLostOpen} />
    </section>
  )
}

function Stepper({
  status,
  disabled,
  pendingTarget,
  onSelect,
}: {
  status: LeadPipelineStatus
  disabled: boolean
  pendingTarget: LeadPipelineStatus | null
  onSelect: (step: LeadPipelineStatus) => void
}) {
  const scrollerRef = useRef<HTMLOListElement>(null)
  const currentIndex = (PIPELINE_STEPS as readonly LeadPipelineStatus[]).indexOf(status)

  // Текущую стадию — в видимую часть ряда (только горизонтально, без прыжка страницы).
  useEffect(() => {
    const scroller = scrollerRef.current
    const current = scroller?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!scroller || !current) return
    const left = current.offsetLeft - (scroller.clientWidth - current.offsetWidth) / 2
    scroller.scrollLeft = Math.max(0, left)
  }, [status])

  return (
    <ol
      ref={scrollerRef}
      aria-label="Стадии воронки"
      className="relative -mx-4 mt-3 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-5 sm:px-5 [&::-webkit-scrollbar]:hidden"
    >
      {PIPELINE_STEPS.map((step, index) => {
        const current = step === status
        const done = currentIndex > index
        const pending = pendingTarget === step
        return (
          <li key={step} className="flex shrink-0 items-center gap-1.5">
            {index > 0 && (
              <span
                aria-hidden="true"
                className={cn('h-px w-3 shrink-0', done || current ? 'bg-fg-muted' : 'bg-border')}
              />
            )}
            <button
              type="button"
              aria-current={current ? 'step' : undefined}
              disabled={disabled}
              onClick={() => onSelect(step)}
              className={cn(
                'inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3.5 py-2 text-sm font-medium whitespace-nowrap transition-colors motion-reduce:transition-none [touch-action:manipulation]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed',
                current
                  ? 'bg-primary text-primary-foreground shadow-[var(--shadow-capsule)]'
                  : done
                    ? 'bg-surface-2 text-fg hover:bg-neutral-bg'
                    : 'border border-border bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg',
                disabled && !current && 'opacity-60'
              )}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : done ? (
                <Check className="size-3.5" aria-hidden="true" />
              ) : null}
              {PIPELINE_STATUS_RU[step]}
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function ClosedBanner({ lead }: { lead: LeadDetail }) {
  if (lead.pipelineStatus === 'WON') {
    return (
      <div className="mt-3 rounded-xl bg-success-bg px-3 py-2.5 text-sm text-success-fg">
        <p className="font-semibold">
          Стал клиентом{lead.wonAt && ` · ${formatMskDateTimeShort(lead.wonAt)}`}
        </p>
        {lead.dealAmount !== null && <p className="mt-0.5">Выручка: {formatMoney(lead.dealAmount)} в месяц</p>}
      </div>
    )
  }
  return (
    <div className="mt-3 rounded-xl bg-danger-bg px-3 py-2.5 text-sm text-danger-fg">
      <p className="font-semibold">
        Отказ{lead.lostAt && ` · ${formatMskDateTimeShort(lead.lostAt)}`}
      </p>
      {lead.lostReason && <p className="mt-0.5">Причина: {LOST_REASON_RU[lead.lostReason]}</p>}
      {lead.lostComment && <p className="mt-0.5 whitespace-pre-line break-words">«{lead.lostComment}»</p>}
    </div>
  )
}
