'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronRight,
  Clock3,
  ExternalLink,
  LoaderCircle,
  MapPin,
  Navigation,
  Package,
  Phone,
  RefreshCw,
  Send,
  ShieldAlert,
  Tag,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { completeOwnRouteStop, requestDeliveryOverride } from '../route-actions'
import { IssueDialog } from './issue-dialog'
import { RouteRefreshControl } from './route-refresh-control'
import {
  completionStateFromGeoResult,
  completionStateFromStop,
  geolocationFailureState,
  getAvailableOverrideGeoAttemptId,
  type CourierCompletionState,
} from '@/lib/delivery/courier-stop-ui-state'
import type { CourierRouteStopView } from '@/lib/delivery/courier-route-read-model'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { formatDeliveryWindow, formatPortions } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'

interface Props {
  stop: CourierRouteStopView
  nextStopId: string | null
  routeProgress?: {
    delivered: number
    total: number
    remaining: number
  }
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `gps-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function packagingLabel(packaging: CourierRouteStopView['items'][number]['packaging']): string {
  return packaging === 'INDIVIDUAL' ? 'Индивидуальная упаковка' : 'Коробками'
}

function stateCanRetry(kind: CourierCompletionState['kind']): boolean {
  return [
    'outside',
    'low_accuracy',
    'stale',
    'future',
    'invalid',
    'no_coordinates',
    'target_unavailable',
    'offline',
    'denied',
    'timeout',
    'server_error',
    'override_rejected',
    'override_expired',
  ].includes(kind)
}

function stateIsBusy(kind: CourierCompletionState['kind']): boolean {
  return kind === 'locating' || kind === 'submitting' || kind === 'override_submitting'
}

function CompletionNotice({
  state,
  notificationWarning,
}: {
  state: CourierCompletionState
  notificationWarning: boolean
}) {
  const content = (() => {
    switch (state.kind) {
      case 'locating':
        return { tone: 'info', title: 'Определяем геопозицию', text: 'Не закрывайте экран. Обычно это занимает несколько секунд.' }
      case 'submitting':
        return { tone: 'info', title: 'Проверяем и подтверждаем', text: 'Доставка появится выполненной только после ответа сервера.' }
      case 'outside':
        return {
          tone: 'warning',
          title: 'Вы за пределами геозоны',
          text: state.distanceM === null
            ? 'Подойдите ближе к точке и повторите проверку.'
            : `До точки примерно ${Math.round(state.distanceM)} м. Подойдите ближе и повторите проверку.`,
        }
      case 'low_accuracy':
        return { tone: 'warning', title: 'Низкая точность GPS', text: 'Выйдите на открытое место, включите точную геопозицию и попробуйте снова.' }
      case 'stale':
        return { tone: 'warning', title: 'Позиция устарела', text: 'Получите геопозицию ещё раз.' }
      case 'future':
      case 'invalid':
        return { tone: 'warning', title: 'Не удалось проверить позицию', text: 'Проверьте время на телефоне и повторите попытку.' }
      case 'target_unavailable':
        return { tone: 'warning', title: 'Координаты точки не настроены', text: 'Запросите подтверждение у менеджера — он сможет закрыть доставку вручную.' }
      case 'no_coordinates':
        return { tone: 'warning', title: 'Геопозиция недоступна', text: 'Включите геолокацию на телефоне и повторите попытку.' }
      case 'denied':
        return { tone: 'danger', title: 'Доступ к геопозиции запрещён', text: 'Разрешите геопозицию для сайта в настройках браузера или запросите подтверждение менеджера.' }
      case 'timeout':
        return { tone: 'warning', title: 'GPS не ответил вовремя', text: 'Перейдите на открытое место и повторите попытку.' }
      case 'offline':
        return { tone: 'warning', title: 'Нет подключения к интернету', text: 'Подключитесь к сети. Без ответа сервера доставка не будет отмечена выполненной.' }
      case 'server_error':
        return { tone: 'danger', title: 'Не удалось подтвердить доставку', text: state.message }
      case 'override_submitting':
        return { tone: 'info', title: 'Отправляем запрос менеджеру', text: 'Запрос сначала сохраняется в CRM.' }
      case 'override_pending':
        return {
          tone: 'warning',
          title: 'Решение менеджера ожидается',
          text: notificationWarning
            ? 'Запрос сохранён в CRM, но Telegram-уведомление не отправилось. Менеджер всё равно увидит запрос в контроле доставки.'
            : 'Экран обновляется автоматически. После одобрения доставка закроется на сервере.',
        }
      case 'override_approved':
        return { tone: 'success', title: 'Менеджер одобрил запрос', text: 'Обновляем подтверждение доставки.' }
      case 'override_rejected':
        return { tone: 'danger', title: 'Менеджер отклонил запрос', text: 'Повторите GPS-проверку на точке или свяжитесь с менеджером.' }
      case 'override_expired':
        return { tone: 'warning', title: 'Время запроса истекло', text: 'Повторите GPS-проверку и при необходимости создайте новый запрос.' }
      default:
        return null
    }
  })()

  if (!content) return null
  const Icon = content.tone === 'info'
    ? LoaderCircle
    : content.tone === 'success'
      ? Check
      : content.tone === 'danger'
        ? ShieldAlert
        : AlertCircle

  return (
    <div
      role={content.tone === 'danger' ? 'alert' : 'status'}
      aria-live={content.tone === 'danger' ? 'assertive' : 'polite'}
      className={cn(
        'rounded-card border p-4',
        content.tone === 'info' && 'border-info/30 bg-info-bg text-info-fg',
        content.tone === 'warning' && 'border-warning/30 bg-warning-bg text-warning-fg',
        content.tone === 'danger' && 'border-danger/30 bg-danger-bg text-danger-fg',
        content.tone === 'success' && 'border-success/30 bg-success-bg text-success-fg',
      )}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn('mt-0.5 size-5 shrink-0', (state.kind === 'locating' || state.kind === 'submitting' || state.kind === 'override_submitting') && 'animate-spin motion-reduce:animate-none')}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div>
          <p className="font-bold">{content.title}</p>
          <p className="mt-1 text-sm leading-6 opacity-90">{content.text}</p>
        </div>
      </div>
    </div>
  )
}

export function CourierStopScreen({ stop, nextStopId, routeProgress }: Props) {
  const router = useRouter()
  const persistedOverrideAttemptId = getAvailableOverrideGeoAttemptId({
    latestGeoAttemptId: stop.latestGeoAttempt?.id ?? null,
    overrideRequestId: stop.latestGeoAttempt?.overrideRequestId ?? null,
    deliveredAt: stop.deliveredAt,
  })
  const [state, setState] = useState<CourierCompletionState>(() => completionStateFromStop({
    deliveredAt: stop.deliveredAt,
    overrideStatus: stop.override?.status ?? null,
  }))
  const [lastGeoAttemptId, setLastGeoAttemptId] = useState<string | null>(
    () => persistedOverrideAttemptId,
  )
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overrideComment, setOverrideComment] = useState('')
  const [notificationWarning, setNotificationWarning] = useState(false)
  const [issueOpen, setIssueOpen] = useState(false)
  const [isMutating, startMutation] = useTransition()
  const overrideTriggerRef = useRef<HTMLButtonElement>(null)
  const overrideCommentRef = useRef<HTMLTextAreaElement>(null)
  const restoreOverrideFocusRef = useRef(false)

  useEffect(() => {
    setState(completionStateFromStop({
      deliveredAt: stop.deliveredAt,
      overrideStatus: stop.override?.status ?? null,
    }))
    setLastGeoAttemptId(getAvailableOverrideGeoAttemptId({
      latestGeoAttemptId: stop.latestGeoAttempt?.id ?? null,
      overrideRequestId: stop.latestGeoAttempt?.overrideRequestId ?? null,
      deliveredAt: stop.deliveredAt,
    }))
  }, [
    stop.deliveredAt,
    stop.latestGeoAttempt?.id,
    stop.latestGeoAttempt?.overrideRequestId,
    stop.override?.status,
  ])

  useEffect(() => {
    if (overrideOpen) {
      overrideCommentRef.current?.focus()
      return
    }
    if (restoreOverrideFocusRef.current) {
      restoreOverrideFocusRef.current = false
      overrideTriggerRef.current?.focus()
    }
  }, [overrideOpen])

  const mapsUrl = useMemo(
    () => `https://yandex.ru/maps/?text=${encodeURIComponent(stop.locationAddress)}`,
    [stop.locationAddress],
  )
  const windowText = formatDeliveryWindow(stop.deliveryWindowFrom, stop.deliveryWindowTo)
    .replace(' — ', '–')
  const isDelivered = Boolean(stop.deliveredAt) || state.kind === 'delivered'
  const busy = isMutating || stateIsBusy(state.kind)
  const canRequestOverride = Boolean(lastGeoAttemptId)
    && !['override_pending', 'override_submitting', 'delivered'].includes(state.kind)

  async function submitToServer(
    position: {
      latitude: number
      longitude: number
      accuracyM: number
      capturedAt: Date
    } | null,
    browserFailure?: CourierCompletionState,
  ) {
    setState({ kind: 'submitting' })
    const result = await completeOwnRouteStop({
      stopId: stop.id,
      expectedVersion: stop.version,
      requestId: createRequestId(),
      position,
    })
    if (!result.ok) {
      setState({ kind: 'server_error', message: result.error })
      return
    }
    if (result.data.delivered) {
      setState({ kind: 'delivered' })
      router.refresh()
      return
    }

    setLastGeoAttemptId(result.data.geoAttempt.id || null)
    setState(browserFailure ?? completionStateFromGeoResult(
      result.data.geoAttempt.result,
      result.data.geoAttempt.id,
      result.data.geoAttempt.distanceM,
    ))
    router.refresh()
  }

  function confirmDelivery() {
    if (busy || isDelivered) return
    startMutation(async () => {
      if (!navigator.onLine) {
        setState({ kind: 'offline' })
        return
      }
      if (!stop.geofence.enabled) {
        await submitToServer(null)
        return
      }
      if (!stop.geofence.hasCoordinates) {
        await submitToServer(null)
        return
      }
      if (!navigator.geolocation) {
        await submitToServer(null, { kind: 'no_coordinates' })
        return
      }

      setState({ kind: 'locating' })
      navigator.geolocation.getCurrentPosition(
        (position) => {
          startMutation(async () => {
            await submitToServer({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracyM: position.coords.accuracy,
              capturedAt: new Date(position.timestamp),
            })
          })
        },
        (error) => {
          const browserState = geolocationFailureState(error.code)
          startMutation(async () => {
            await submitToServer(null, browserState)
          })
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 15_000,
        },
      )
    })
  }

  function submitOverride() {
    const comment = overrideComment.trim()
    if (!lastGeoAttemptId || !comment || busy) return
    setState({ kind: 'override_submitting' })
    startMutation(async () => {
      const result = await requestDeliveryOverride({
        stopId: stop.id,
        geoAttemptId: lastGeoAttemptId,
        comment,
      })
      if (!result.ok) {
        setState({ kind: 'server_error', message: result.error })
        return
      }
      setNotificationWarning(result.data.notificationFailed)
      setOverrideOpen(false)
      setState({ kind: 'override_pending' })
      router.refresh()
    })
  }

  function closeOverride() {
    restoreOverrideFocusRef.current = true
    setOverrideOpen(false)
  }

  const buttonLabel = stateCanRetry(state.kind)
    ? 'Повторить проверку GPS'
    : state.kind === 'locating'
      ? 'Определяем геопозицию…'
      : state.kind === 'submitting'
        ? 'Подтверждаем…'
        : 'Подтвердить доставку'

  return (
    <article className="mx-auto max-w-2xl pb-28" aria-labelledby="courier-stop-title">
      <header className="mb-5 flex items-center justify-between gap-3">
        <Link
          href="/delivery"
          className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-pill px-2 text-sm font-semibold text-fg-muted transition-colors hover:text-fg motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [touch-action:manipulation]"
        >
          <ArrowLeft className="size-5" strokeWidth={1.75} aria-hidden="true" />
          Все точки
        </Link>
        <RouteRefreshControl />
      </header>

      {routeProgress && (
        <div className="mb-4 rounded-card border border-border bg-surface px-4 py-3 shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="font-semibold text-fg">Маршрут: {routeProgress.delivered} из {routeProgress.total}</span>
            <span className="font-medium text-fg-muted">Осталось {routeProgress.remaining}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-pill bg-data-orders-bg" role="progressbar" aria-label="Прогресс маршрута" aria-valuemin={0} aria-valuemax={routeProgress.total} aria-valuenow={routeProgress.delivered}>
            <div className="h-full rounded-pill bg-data-orders" style={{ width: `${routeProgress.total === 0 ? 0 : Math.round((routeProgress.delivered / routeProgress.total) * 100)}%` }} />
          </div>
        </div>
      )}

      {isDelivered && (
        <section className="mb-5 rounded-3xl border border-success/30 bg-success-bg p-6 text-center" aria-live="polite">
          <span className="mx-auto inline-flex size-14 items-center justify-center rounded-full bg-surface text-success-fg">
            <Check className="size-7" strokeWidth={2.25} aria-hidden="true" />
          </span>
          <h2 className="mt-3 text-xl font-bold text-success-fg">Доставка подтверждена</h2>
          <p className="mt-1 text-sm text-success-fg">Статус сохранён на сервере.</p>
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            {nextStopId && (
              <Link href={`/delivery/stops/${nextStopId}`} className="inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-capsule)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2">
                Следующая точка
                <ChevronRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </Link>
            )}
            <Link href="/delivery" className="inline-flex min-h-12 cursor-pointer items-center justify-center rounded-pill border border-border bg-surface px-5 py-3 text-sm font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2">
              Все точки
            </Link>
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-3xl border border-border bg-surface shadow-[var(--shadow-card)]">
        <div className="bg-data-orders-bg px-5 py-5 text-data-orders-ink">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-sm font-bold">
              <Clock3 className="size-5" strokeWidth={1.75} aria-hidden="true" />
              {windowText || 'Окно не указано'}
            </span>
            {stop.state === 'LATE' && (
              <span className="rounded-pill bg-danger-bg px-3 py-1 text-xs font-bold text-danger-fg">Опоздание</span>
            )}
          </div>
          <h1 id="courier-stop-title" className="mt-4 text-2xl font-extrabold text-fg">{stop.locationName}</h1>
          <p className="mt-1 text-base font-semibold text-fg-muted">{stop.clientName}</p>
          <p className="mt-4 text-3xl font-extrabold tabular-nums text-data-orders-ink">{formatPortions(stop.totalPortions)}</p>
        </div>

        <div className="space-y-5 p-5">
          <section aria-labelledby="address-title">
            <h2 id="address-title" className="text-xs font-bold uppercase tracking-wide text-fg-muted">Адрес</h2>
            <p className="mt-2 text-base font-semibold leading-6 text-fg">{stop.locationAddress}</p>
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border border-border px-4 py-2 text-sm font-semibold text-info-fg transition-colors hover:bg-info-bg motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40 [touch-action:manipulation]">
              <Navigation className="size-4" strokeWidth={1.75} aria-hidden="true" />
              Открыть в Яндекс.Картах
              <ExternalLink className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            </a>
          </section>

          {(stop.contactName || stop.contactPhone || stop.contactNotes) && (
            <section className="rounded-card bg-surface-2 p-4" aria-labelledby="contact-title">
              <h2 id="contact-title" className="text-xs font-bold uppercase tracking-wide text-fg-muted">Контакт на точке</h2>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Phone className="size-4 text-fg-muted" strokeWidth={1.75} aria-hidden="true" />
                {stop.contactName && <span className="font-bold text-fg">{stop.contactName}</span>}
                {stop.contactPhone && (
                  <a href={`tel:${stop.contactPhone.replace(/[^+\d]/g, '')}`} className="inline-flex min-h-11 cursor-pointer items-center rounded-pill px-2 text-sm font-bold text-info-fg underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40">
                    {stop.contactPhone}
                  </a>
                )}
              </div>
              {stop.contactNotes && <p className="mt-1 text-sm leading-6 text-fg-muted">{stop.contactNotes}</p>}
            </section>
          )}

          {stop.deliveryInstructions && (
            <section className="rounded-card border border-info/25 bg-info-bg p-4 text-info-fg" aria-labelledby="instructions-title">
              <h2 id="instructions-title" className="flex items-center gap-2 font-bold">
                <MapPin className="size-4" strokeWidth={1.75} aria-hidden="true" />
                Инструкция точки
              </h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-6">{stop.deliveryInstructions}</p>
            </section>
          )}

          <section aria-labelledby="cargo-title">
            <h2 id="cargo-title" className="text-lg font-bold text-fg">Что передать</h2>
            <div className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border">
              {stop.items.map((item) => (
                <div key={item.orderId} className="flex items-start gap-3 bg-surface px-4 py-3">
                  <Package className="mt-0.5 size-5 shrink-0 text-data-orders-ink" strokeWidth={1.75} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-fg">{MEAL_TYPE_LABELS[item.mealType]}</p>
                    <p className="mt-0.5 text-sm text-fg-muted">{packagingLabel(item.packaging)}</p>
                  </div>
                  <span className="shrink-0 font-extrabold tabular-nums text-fg">{formatPortions(item.portions)}</span>
                </div>
              ))}
            </div>
          </section>

          {stop.tags.length > 0 && (
            <section aria-labelledby="tags-title">
              <h2 id="tags-title" className="text-xs font-bold uppercase tracking-wide text-fg-muted">Теги</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {stop.tags.map((item) => (
                  <span key={item} className="inline-flex items-center gap-1.5 rounded-pill bg-data-amount-bg px-3 py-1.5 text-xs font-semibold text-data-amount-ink">
                    <Tag className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                    {item}
                  </span>
                ))}
              </div>
            </section>
          )}

          {stop.notes.length > 0 && (
            <section className="rounded-card border border-warning/25 bg-warning-bg p-4 text-warning-fg" aria-labelledby="notes-title">
              <h2 id="notes-title" className="font-bold">Заметки к заказу</h2>
              <ul className="mt-2 space-y-1 text-sm leading-6">
                {stop.notes.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>
          )}
        </div>
      </section>

      {!isDelivered && (
        <div className="mt-5 space-y-4">
          <CompletionNotice state={state} notificationWarning={notificationWarning} />

          {canRequestOverride && (
            <button
              ref={overrideTriggerRef}
              type="button"
              onClick={() => setOverrideOpen(true)}
              aria-expanded={overrideOpen}
              aria-controls="delivery-override-panel"
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border border-border bg-surface px-4 py-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-2 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [touch-action:manipulation]"
            >
              <ShieldAlert className="size-4" strokeWidth={1.75} aria-hidden="true" />
              Запросить подтверждение у менеджера
            </button>
          )}

          {overrideOpen && !isDelivered && (
            <section id="delivery-override-panel" className="rounded-card border border-border bg-surface p-4 shadow-[var(--shadow-card)]" aria-labelledby="override-title" aria-busy={state.kind === 'override_submitting'}>
              <h2 id="override-title" className="font-bold text-fg">Запрос менеджеру</h2>
              <p className="mt-1 text-sm leading-6 text-fg-muted">Опишите, почему доставку нужно подтвердить без успешной GPS-проверки.</p>
              <label htmlFor="delivery-override-comment" className="mt-4 block text-sm font-semibold text-fg">Комментарий <span aria-hidden="true">*</span></label>
              <textarea ref={overrideCommentRef} id="delivery-override-comment" value={overrideComment} onChange={(event) => setOverrideComment(event.target.value)} maxLength={1_000} rows={4} required className="mt-2 min-h-24 w-full rounded-2xl border border-border bg-surface px-3 py-3 text-base text-fg outline-none transition-colors focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 motion-reduce:transition-none" placeholder="Например: охрана не пропускает ближе к зданию" />
              <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" onClick={closeOverride} disabled={busy} className="min-h-11 cursor-pointer rounded-pill border border-border px-4 py-2 text-sm font-semibold text-fg disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">Отмена</button>
                <button type="button" onClick={submitOverride} disabled={busy || !overrideComment.trim()} className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-pill bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-capsule)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2">
                  <Send className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  Отправить менеджеру
                </button>
              </div>
            </section>
          )}
        </div>
      )}

      {!isDelivered && (
        <div className="sticky bottom-[calc(62px+env(safe-area-inset-bottom))] z-30 -mx-4 mt-6 border-t border-border bg-bg px-4 py-3 lg:bottom-4 lg:mx-0 lg:rounded-3xl lg:border lg:shadow-[var(--shadow-float)]">
          <div className="space-y-2">
            {!stop.route.started ? (
              <Link href="/delivery" className="inline-flex min-h-14 w-full cursor-pointer items-center justify-center rounded-pill border border-border bg-surface px-5 py-4 text-base font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2">
                Сначала начните маршрут
              </Link>
            ) : state.kind === 'override_pending' || state.kind === 'override_submitting' ? (
              <button type="button" disabled className="inline-flex min-h-14 w-full cursor-not-allowed items-center justify-center gap-2 rounded-pill bg-surface-2 px-5 py-4 text-base font-semibold text-fg-muted opacity-80">
                <Clock3 className="size-5" strokeWidth={1.75} aria-hidden="true" />
                Ожидаем менеджера
              </button>
            ) : (
              <button type="button" onClick={confirmDelivery} disabled={busy} className="inline-flex min-h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-pill bg-primary px-5 py-4 text-base font-semibold text-primary-foreground shadow-[var(--shadow-capsule)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 [touch-action:manipulation]">
                {busy ? <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" strokeWidth={1.75} aria-hidden="true" /> : stateCanRetry(state.kind) ? <RefreshCw className="size-5" strokeWidth={1.75} aria-hidden="true" /> : <Check className="size-5" strokeWidth={2} aria-hidden="true" />}
                {buttonLabel}
              </button>
            )}
            <button type="button" onClick={() => setIssueOpen(true)} className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center text-sm font-semibold text-fg-muted underline underline-offset-4 transition-colors hover:text-danger-fg motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 [touch-action:manipulation]">
              Не смог доставить
            </button>
          </div>
        </div>
      )}

      <IssueDialog
        open={issueOpen}
        orderIds={stop.items.map((item) => item.orderId)}
        onClose={() => setIssueOpen(false)}
        onReported={() => router.refresh()}
      />
    </article>
  )
}
