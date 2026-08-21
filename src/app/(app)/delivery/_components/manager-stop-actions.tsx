'use client'

import { useState, useTransition } from 'react'
import type { FormEvent } from 'react'
import { Check, Save, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import {
  assignCourierRouteStop,
  resolveDeliveryOverrideAsManager,
} from '../route-actions'
import type {
  ManagerCourierOption,
  ManagerStopDetailView,
} from '@/lib/delivery/manager-control-read-model'

interface Props {
  stop: Pick<
    ManagerStopDetailView,
    'id' | 'version' | 'state' | 'assignmentMode' | 'override'
  >
  couriers: ManagerCourierOption[]
  currentCourierId: string
}

type AssignmentMode = 'IN_HOUSE' | 'EXTERNAL' | 'UNASSIGNED'
type ActiveAction = 'assignment' | 'approve' | 'reject'

const fieldClassName = [
  'min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 py-2 text-base text-fg',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1',
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-muted',
].join(' ')

export function ManagerStopActions({ stop, couriers, currentCourierId }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>(stop.assignmentMode)
  const [courierId, setCourierId] = useState(currentCourierId)
  const [resolutionComment, setResolutionComment] = useState('')
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [activeAction, setActiveAction] = useState<ActiveAction | null>(null)
  const assignmentDisabled = isPending || stop.state === 'DELIVERED'
  const pendingOverride = stop.override?.status === 'PENDING' ? stop.override : null

  function saveAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFeedback(null)
    setActiveAction('assignment')
    startTransition(async () => {
      try {
        const result = await assignCourierRouteStop({
          stopId: stop.id,
          expectedVersion: stop.version,
          assignmentMode,
          courierId: assignmentMode === 'IN_HOUSE' ? courierId : null,
        })
        if (!result.ok) {
          setFeedback({ tone: 'error', text: result.error })
          return
        }
        setFeedback({ tone: 'success', text: 'Назначение сохранено.' })
        router.refresh()
      } finally {
        setActiveAction(null)
      }
    })
  }

  function resolveOverride(decision: 'APPROVE' | 'REJECT') {
    if (!pendingOverride) return
    setFeedback(null)
    setActiveAction(decision === 'APPROVE' ? 'approve' : 'reject')
    startTransition(async () => {
      try {
        const result = await resolveDeliveryOverrideAsManager({
          requestId: pendingOverride.id,
          decision,
          comment: resolutionComment.trim() || null,
        })
        if (!result.ok) {
          setFeedback({ tone: 'error', text: result.error })
          return
        }
        setFeedback({
          tone: 'success',
          text: decision === 'APPROVE'
            ? 'Доставка подтверждена.'
            : 'Запрос отклонён.',
        })
        router.refresh()
      } finally {
        setActiveAction(null)
      }
    })
  }

  return (
    <div className="space-y-5">
      <form onSubmit={saveAssignment} className="space-y-4" aria-labelledby="assignment-title">
        <div>
          <h3 id="assignment-title" className="font-bold text-fg">Назначение точки</h3>
          <p className="mt-1 text-sm leading-6 text-fg-muted">
            Изменение действует только на эту доставку и не меняет настройки клиента.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm font-semibold text-fg">
            Способ доставки
            <select
              value={assignmentMode}
              onChange={(event) => setAssignmentMode(event.target.value as AssignmentMode)}
              disabled={assignmentDisabled}
              className={fieldClassName}
            >
              <option value="IN_HOUSE">Штатный курьер</option>
              <option value="EXTERNAL">InDrive</option>
              <option value="UNASSIGNED">Не назначено</option>
            </select>
          </label>

          <label className="space-y-1.5 text-sm font-semibold text-fg">
            Курьер
            <select
              value={courierId}
              onChange={(event) => setCourierId(event.target.value)}
              disabled={assignmentDisabled || assignmentMode !== 'IN_HOUSE'}
              required={assignmentMode === 'IN_HOUSE'}
              className={fieldClassName}
            >
              <option value="">Выберите курьера</option>
              {couriers.map((courier) => (
                <option key={courier.id} value={courier.id}>{courier.name}</option>
              ))}
            </select>
          </label>
        </div>

        <button
          type="submit"
          disabled={assignmentDisabled || (assignmentMode === 'IN_HOUSE' && !courierId)}
          className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-pill bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-capsule)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 [touch-action:manipulation]"
        >
          <Save className="size-4" strokeWidth={1.75} aria-hidden="true" />
          {activeAction === 'assignment' ? 'Сохраняем…' : 'Сохранить назначение'}
        </button>

        {stop.state === 'DELIVERED' && (
          <p className="text-sm text-fg-muted">Доставленная точка больше не переназначается.</p>
        )}
      </form>

      {pendingOverride && (
        <section className="space-y-4 border-t border-border pt-5" aria-labelledby="override-decision-title">
          <div>
            <h3 id="override-decision-title" className="font-bold text-fg">Решение по override</h3>
            <p className="mt-1 text-sm leading-6 text-fg-muted">Комментарий курьера: {pendingOverride.comment}</p>
          </div>
          <label className="block space-y-1.5 text-sm font-semibold text-fg">
            Комментарий менеджера <span className="font-normal text-fg-muted">(необязательно)</span>
            <textarea
              value={resolutionComment}
              onChange={(event) => setResolutionComment(event.target.value)}
              disabled={isPending}
              rows={3}
              maxLength={1_000}
              className={`${fieldClassName} resize-y`}
              placeholder="Что учесть курьеру"
            />
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => resolveOverride('APPROVE')}
              disabled={isPending}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-pill bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 [touch-action:manipulation]"
            >
              <Check className="size-4" strokeWidth={2} aria-hidden="true" />
              {activeAction === 'approve' ? 'Подтверждаем…' : 'Подтвердить доставку'}
            </button>
            <button
              type="button"
              onClick={() => resolveOverride('REJECT')}
              disabled={isPending}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-pill border border-danger/40 bg-surface px-5 py-2.5 text-sm font-semibold text-danger-fg transition-colors hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:ring-offset-2 [touch-action:manipulation]"
            >
              <X className="size-4" strokeWidth={2} aria-hidden="true" />
              {activeAction === 'reject' ? 'Отклоняем…' : 'Отклонить'}
            </button>
          </div>
        </section>
      )}

      <div aria-live="polite" aria-atomic="true">
        {feedback && (
          <p
            role={feedback.tone === 'error' ? 'alert' : 'status'}
            className={feedback.tone === 'error'
              ? 'rounded-card border border-danger/30 bg-danger-bg p-3 text-sm font-semibold text-danger-fg'
              : 'rounded-card border border-success/30 bg-success-bg p-3 text-sm font-semibold text-success-fg'}
          >
            {feedback.text}
          </p>
        )}
      </div>
    </div>
  )
}
