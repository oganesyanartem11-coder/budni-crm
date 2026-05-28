'use client'

/**
 * Таб «Команда» страницы /boris — Спринт 7.16.C ЭТАП 2 (Subagent C, C4).
 *
 * Видимость: вся страница /boris сейчас защищена requireRole(['ADMIN_PRO']),
 * поэтому все 4 секции (manual-trigger, feed, журнал событий, метрики)
 * показываются одинаково — фильтра по роли внутри компонента нет.
 *
 * Если в будущем /boris откроют для ADMIN — нужно будет завести проп
 * isAdminPro и спрятать секции 1/3/4 для не-PRO-админов.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { cn } from '@/lib/utils/cn'
import { formatDateTimeMsk, formatDateMsk } from '@/lib/utils/format'
import {
  triggerTeamEveningDigest,
  triggerTeamFriday,
  triggerTestAlert,
} from '../actions'
import type { BriefingType, BorisEventType, MealType } from '@prisma/client'
import type { TeamWeeklyMetrics } from '@/lib/db/queries/boris-briefings'

// ============================================================
// Types
// ============================================================

export type SerializedTeamBriefing = {
  id: string
  type: BriefingType
  generatedAt: Date | string
  recipientUserId: string | null
  recipient: { id: string; name: string } | null
  recipientChatId: string
  content: string
  contextData: unknown
  sentToTg: boolean
  tgMessageId: string | null
  errorMessage: string | null
  isDryRun: boolean
  inputTokens: number
  outputTokens: number
  costUsd: number
  createdAt: Date | string
}

export type SerializedTeamEvent = {
  id: string
  eventType: BorisEventType
  eventDate: Date | string
  clientId: string | null
  client: { id: string; name: string } | null
  orderId: string | null
  order: { id: string; deliveryDate: Date | string; mealType: MealType } | null
  menuCycleId: string | null
  menuCycle: { id: string; name: string } | null
  payload: unknown
  deduplKey: string
  emittedTo: 'LIVE' | 'EVENING' | 'FRIDAY' | 'ALERT' | null
  emittedAt: Date | string | null
  createdAt: Date | string
}

interface Props {
  teamBriefings: SerializedTeamBriefing[]
  teamEvents: SerializedTeamEvent[]
  teamMetricsWeek: TeamWeeklyMetrics & { weekFrom: Date | string; weekTo: Date | string }
}

// ============================================================
// Russian labels (single source of truth)
// ============================================================

const EVENT_TYPE_LABELS_RU: Record<BorisEventType, string> = {
  THANKS: 'Спасибо',
  FIRST_DELIVERY: 'Первая отгрузка',
  MENU_APPROVED: 'Меню утверждено',
  URGENT_NEAR_DELIVERY: 'Срочный сигнал',
  RUDE: 'Негатив клиента',
  RECORD_DAY: 'Рекорд дня',
  COMPLAINT_FREE_WEEK: 'Неделя без жалоб',
  ANNIVERSARY: 'Юбилей',
  COURIER_ON_TIME_STREAK: 'Курьер вовремя',
  BIG_INVOICE: 'Большая накладная',
  STABLE_PRICE: 'Стабильная цена',
}

const CHANNEL_LABELS_RU: Record<'LIVE' | 'EVENING' | 'FRIDAY' | 'ALERT', string> = {
  LIVE: '🟢 LIVE',
  EVENING: '🌙 EVENING',
  FRIDAY: '🗓 FRIDAY',
  ALERT: '🚨 ALERT',
}

const SOURCE_LABELS_RU: Record<
  'TEAM_LIVE' | 'TEAM_EVENING' | 'TEAM_FRIDAY' | 'TEAM_ALERT',
  string
> = {
  TEAM_LIVE: '🟢 Живо',
  TEAM_EVENING: '🌙 Итог дня',
  TEAM_FRIDAY: '🗓 Пятница',
  TEAM_ALERT: '🚨 Тревога',
}

function briefingTypeLabel(type: BriefingType): string {
  if (
    type === 'TEAM_LIVE' ||
    type === 'TEAM_EVENING' ||
    type === 'TEAM_FRIDAY' ||
    type === 'TEAM_ALERT'
  ) {
    return SOURCE_LABELS_RU[type]
  }
  return type
}

// ============================================================
// Component
// ============================================================

export function TeamTabView({ teamBriefings, teamEvents, teamMetricsWeek }: Props) {
  const router = useRouter()
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const [eventTypeFilter, setEventTypeFilter] = useState<BorisEventType | 'ALL'>('ALL')

  async function runAction(
    key: string,
    fn: () => Promise<
      { ok: true; message?: string } | { ok: false; error: string }
    >,
    confirmText?: string,
  ) {
    if (confirmText && !window.confirm(confirmText)) return
    setBusyAction(key)
    try {
      const res = await fn()
      if (res.ok) {
        toast.success(res.message ?? 'Готово')
        startTransition(() => router.refresh())
      } else {
        toast.error(`Ошибка: ${res.error}`)
      }
    } catch (e) {
      toast.error(`Ошибка: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyAction(null)
    }
  }

  const filteredEvents =
    eventTypeFilter === 'ALL'
      ? teamEvents
      : teamEvents.filter((e) => e.eventType === eventTypeFilter)

  // Уникальный набор eventType, реально встречающихся в журнале — для чипов фильтра.
  const eventTypesInLog = Array.from(
    new Set(teamEvents.map((e) => e.eventType)),
  ) as BorisEventType[]

  return (
    <div className="space-y-8">
      {/* Section 1 — manual triggers */}
      <section className="space-y-3">
        <h3 className="text-base font-semibold text-fg">Ручной запуск каналов</h3>
        <div className="flex flex-wrap gap-2">
          <TriggerButton
            label="Прогнать «Итог дня»"
            disabled={busyAction !== null}
            busy={busyAction === 'evening'}
            onClick={() =>
              runAction(
                'evening',
                triggerTeamEveningDigest,
                'Запустить вечерний итог сейчас? При SEND это уйдёт в групповой чат.',
              )
            }
          />
          <TriggerButton
            label="Прогнать «Пятницу»"
            disabled={busyAction !== null}
            busy={busyAction === 'friday'}
            onClick={() =>
              runAction(
                'friday',
                triggerTeamFriday,
                'Запустить пятничный итог недели сейчас? При SEND это уйдёт в групповой чат.',
              )
            }
          />
          <TriggerButton
            label="Тестовый алёрт"
            variant="danger"
            disabled={busyAction !== null}
            busy={busyAction === 'alert'}
            onClick={() =>
              runAction(
                'alert',
                triggerTestAlert,
                'РЕАЛЬНО отправить тестовый алёрт в групповой чат? Это увидят все.',
              )
            }
          />
        </div>
        <p className="text-xs text-fg-muted">
          «Тестовый алёрт» создаёт fake BorisEventLog и сразу шлёт пост в группу.
          Остальные кнопки дёргают cron-эндпоинт с force=true (идемпотентность сбрасывается).
        </p>
      </section>

      {/* Section 2 — feed постов Бориса (teamBriefings) */}
      <section className="space-y-3">
        <h3 className="text-base font-semibold text-fg">
          Посты Бориса в группу · {teamBriefings.length}
        </h3>
        {teamBriefings.length === 0 ? (
          <div
            className="rounded-2xl bg-surface border border-border p-8 text-center"
            style={{ boxShadow: 'var(--shadow-card)' }}
          >
            <p className="text-sm text-fg-muted">
              Постов в каналы команды ещё не было. Запусти один из триггеров выше.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {teamBriefings.map((b) => (
              <TeamBriefingCard key={b.id} briefing={b} />
            ))}
          </ul>
        )}
      </section>

      {/* Section 3 — журнал BorisEventLog */}
      <section className="space-y-3">
        <h3 className="text-base font-semibold text-fg">
          Журнал событий · {teamEvents.length}
          <span className="text-xs font-normal text-fg-muted ml-2">(admin only)</span>
        </h3>

        {/* Фильтр-чипы */}
        {eventTypesInLog.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <FilterChip
              active={eventTypeFilter === 'ALL'}
              onClick={() => setEventTypeFilter('ALL')}
              label={`Все · ${teamEvents.length}`}
            />
            {eventTypesInLog.map((et) => {
              const n = teamEvents.filter((e) => e.eventType === et).length
              return (
                <FilterChip
                  key={et}
                  active={eventTypeFilter === et}
                  onClick={() => setEventTypeFilter(et)}
                  label={`${EVENT_TYPE_LABELS_RU[et]} · ${n}`}
                />
              )
            })}
          </div>
        )}

        {filteredEvents.length === 0 ? (
          <div
            className="rounded-2xl bg-surface border border-border p-8 text-center"
            style={{ boxShadow: 'var(--shadow-card)' }}
          >
            <p className="text-sm text-fg-muted">Событий ещё нет.</p>
          </div>
        ) : (
          <div
            className="overflow-x-auto rounded-2xl bg-surface border border-border"
            style={{ boxShadow: 'var(--shadow-card)' }}
          >
            <table className="w-full text-sm">
              <thead className="bg-fg/5 text-xs uppercase text-fg-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Время</th>
                  <th className="px-3 py-2 text-left font-medium">Тип</th>
                  <th className="px-3 py-2 text-left font-medium">Клиент</th>
                  <th className="px-3 py-2 text-left font-medium">Куда ушло</th>
                  <th className="px-3 py-2 text-left font-medium">Payload</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredEvents.map((e) => {
                  const payloadStr = (() => {
                    try {
                      return JSON.stringify(e.payload).slice(0, 100)
                    } catch {
                      return '—'
                    }
                  })()
                  return (
                    <tr key={e.id} className="hover:bg-fg/5">
                      <td className="px-3 py-2 whitespace-nowrap text-fg-muted">
                        {formatDateTimeMsk(e.createdAt)}
                      </td>
                      <td className="px-3 py-2 font-medium text-fg whitespace-nowrap">
                        {EVENT_TYPE_LABELS_RU[e.eventType]}
                      </td>
                      <td className="px-3 py-2 text-fg whitespace-nowrap">
                        {e.client?.name ?? '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {e.emittedTo ? (
                          <span className="text-fg">
                            {CHANNEL_LABELS_RU[e.emittedTo]}
                          </span>
                        ) : (
                          <span className="text-fg-muted">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-fg-muted max-w-[300px] truncate">
                        {payloadStr}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 4 — метрики недели */}
      <section className="space-y-3">
        <h3 className="text-base font-semibold text-fg">
          Метрики команды Бориса за финансовую неделю
        </h3>
        <p className="text-sm text-fg-muted">
          {formatDateMsk(teamMetricsWeek.weekFrom)} — {formatDateMsk(teamMetricsWeek.weekTo)}
        </p>

        <div
          className="overflow-x-auto rounded-2xl bg-surface border border-border"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <table className="w-full text-sm">
            <thead className="bg-fg/5 text-xs uppercase text-fg-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Канал</th>
                <th className="px-3 py-2 text-right font-medium">Постов</th>
                <th className="px-3 py-2 text-right font-medium">Стоимость, $</th>
                <th className="px-3 py-2 text-right font-medium">Input tok</th>
                <th className="px-3 py-2 text-right font-medium">Output tok</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {teamMetricsWeek.byChannel.map((row) => (
                <tr key={row.source}>
                  <td className="px-3 py-2 font-medium text-fg">
                    {SOURCE_LABELS_RU[row.source]}
                  </td>
                  <td className="px-3 py-2 text-right text-fg">{row.callCount}</td>
                  <td className="px-3 py-2 text-right text-fg">
                    ${row.costUsd.toFixed(4)}
                  </td>
                  <td className="px-3 py-2 text-right text-fg-muted">
                    {row.inputTokens}
                  </td>
                  <td className="px-3 py-2 text-right text-fg-muted">
                    {row.outputTokens}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap gap-4 text-sm text-fg-muted">
          <span>
            Событий зафиксировано: <b className="text-fg">{teamMetricsWeek.eventCount}</b>
          </span>
          <span>
            SILENT-решений: <b className="text-fg">{teamMetricsWeek.silentCount}</b>
          </span>
        </div>
      </section>
    </div>
  )
}

// ============================================================
// Sub-components
// ============================================================

function TriggerButton({
  label,
  onClick,
  disabled,
  busy,
  variant = 'default',
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  variant?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'px-3 py-1.5 rounded-pill text-sm font-medium transition-colors border',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variant === 'danger'
          ? 'border-red-500/40 text-red-600 hover:bg-red-500/10'
          : 'border-border text-fg hover:bg-fg/5',
      )}
    >
      {busy ? '…' : label}
    </button>
  )
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
        active
          ? 'bg-accent text-accent-fg border-accent'
          : 'border-border text-fg-muted hover:text-fg hover:bg-fg/5',
      )}
    >
      {label}
    </button>
  )
}

function TeamBriefingCard({ briefing }: { briefing: SerializedTeamBriefing }) {
  const channelStyles = channelCardStyles(briefing.type)
  const isSilent = briefing.content === ''

  // Достаём reason/decision из contextData (мягко — структура может варьироваться).
  const silentReason = (() => {
    if (!isSilent) return null
    const cd = briefing.contextData as
      | { briefingPayload?: { reason?: string; decision?: string }; decision?: string }
      | null
      | undefined
    if (!cd) return null
    return (
      cd.briefingPayload?.reason ??
      cd.briefingPayload?.decision ??
      cd.decision ??
      null
    )
  })()

  return (
    <li
      className={cn(
        'rounded-2xl border p-4 space-y-3',
        channelStyles.container,
      )}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={cn(
            'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border',
            channelStyles.chip,
          )}
        >
          {briefingTypeLabel(briefing.type)}
        </span>
        <span className="font-medium text-fg">
          {formatDateTimeMsk(briefing.generatedAt)}
        </span>
        {briefing.isDryRun && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-amber-500/10 text-amber-700 border-amber-500/20">
            dry-run
          </span>
        )}
        {briefing.sentToTg && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-emerald-500/10 text-emerald-700 border-emerald-500/20">
            отправлено в TG
          </span>
        )}
        {!briefing.sentToTg && !isSilent && !briefing.isDryRun && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-red-500/10 text-red-700 border-red-500/20">
            не отправлено
          </span>
        )}
        {isSilent && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-fg/5 text-fg-muted border-border">
            SILENT
          </span>
        )}
      </div>

      {briefing.errorMessage && (
        <div className="text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md p-2">
          {briefing.errorMessage}
        </div>
      )}

      {isSilent ? (
        <div className="text-sm text-fg-muted italic">
          Борис решил промолчать
          {silentReason ? <span>: {silentReason}</span> : null}.
        </div>
      ) : (
        // Контент LLM содержит HTML-теги (<b>, <i>) для TG parseMode='HTML'.
        // Источник доверенный (наш AI, persisted на сервере), DOMPurify в проекте нет.
        <div
          className="text-sm text-fg leading-relaxed [&_b]:font-semibold [&_i]:italic whitespace-pre-wrap break-words"
          dangerouslySetInnerHTML={{ __html: briefing.content }}
        />
      )}

      <div className="text-xs text-fg-muted">
        ${briefing.costUsd.toFixed(4)} · in {briefing.inputTokens} / out{' '}
        {briefing.outputTokens} tok
      </div>
    </li>
  )
}

function channelCardStyles(type: BriefingType): {
  container: string
  chip: string
} {
  switch (type) {
    case 'TEAM_LIVE':
      return {
        container: 'bg-emerald-500/5 border-emerald-500/30',
        chip: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
      }
    case 'TEAM_EVENING':
      return {
        container: 'bg-surface border-border',
        chip: 'bg-fg/5 text-fg-muted border-border',
      }
    case 'TEAM_FRIDAY':
      return {
        container: 'bg-violet-500/5 border-violet-500/30',
        chip: 'bg-violet-500/15 text-violet-700 border-violet-500/30',
      }
    case 'TEAM_ALERT':
      return {
        container: 'bg-red-500/5 border-red-500/30',
        chip: 'bg-red-500/15 text-red-700 border-red-500/30',
      }
    default:
      return {
        container: 'bg-surface border-border',
        chip: 'bg-fg/5 text-fg-muted border-border',
      }
  }
}
