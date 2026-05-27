'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Sun, Brain, BarChart3 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatDateTimeMsk } from '@/lib/utils/format'
import type { BriefingType } from '@prisma/client'
import type { WeeklyMetricsSummary } from '@/lib/db/queries/boris-briefings'

// ============================================================
// Types
// ============================================================

/**
 * Сериализованная форма BorisBriefing (Decimal → number). Recipient берётся
 * через include в query helper, нужен только id+name.
 */
type SerializedBriefing = {
  id: string
  // 7.16.C: BriefingType расширен значениями TEAM_*. UI здесь показывает только
  // MORNING/SELF_ANALYSIS, остальные просто игнорируются — но в типе должен
  // лежать полный union из Prisma, иначе page.tsx не type-check'ится.
  type: BriefingType
  generatedAt: Date | string
  recipientUserId: string | null
  recipient: { id: string; name: string } | null
  recipientChatId: string
  content: string
  // contextData может быть произвольным JSON — для админ-инспектора этого достаточно.
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

interface Props {
  briefingsMorning: SerializedBriefing[]
  briefingsSelfAnalysis: SerializedBriefing[]
  metricsWeek: WeeklyMetricsSummary
}

type Tab = 'morning' | 'self_analysis' | 'metrics'

// ============================================================
// Component
// ============================================================

export function BorisHistoryView({
  briefingsMorning,
  briefingsSelfAnalysis,
  metricsWeek,
}: Props) {
  const [tab, setTab] = useState<Tab>('morning')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  /**
   * Универсальный trigger manual-endpoint'ов. Endpoints создают B1/B2 —
   * до их готовности кнопки могут возвращать 404, это норма для разработки.
   */
  async function triggerEndpoint(url: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(true)
    try {
      const res = await fetch(url, { method: 'POST' })
      const json = (await res.json().catch(() => ({}))) as {
        briefingId?: string
        sentToTg?: boolean
        skipped?: string
        error?: string
      }
      if (!res.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`)
      }
      if (json.skipped) {
        toast.success(
          `Brief создан со статусом skip: ${json.skipped} (ID: ${json.briefingId ?? '—'})`,
        )
      } else {
        toast.success(
          `Создан briefing ID: ${json.briefingId ?? '—'}, sentToTg: ${
            json.sentToTg === undefined ? 'N/A' : String(json.sentToTg)
          }`,
        )
      }
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`Ошибка: ${msg}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        <TabButton
          active={tab === 'morning'}
          onClick={() => setTab('morning')}
          icon={Sun}
          label={`Утренние · ${briefingsMorning.length}`}
        />
        <TabButton
          active={tab === 'self_analysis'}
          onClick={() => setTab('self_analysis')}
          icon={Brain}
          label={`Самоанализ · ${briefingsSelfAnalysis.length}`}
        />
        <TabButton
          active={tab === 'metrics'}
          onClick={() => setTab('metrics')}
          icon={BarChart3}
          label="Метрики Action-Бориса"
        />
      </div>

      {tab === 'morning' && (
        <BriefingsTab
          briefings={briefingsMorning}
          emptyHint="Утренних брифингов пока нет. Запусти dry-run, чтобы убедиться, что генератор работает."
          actions={
            <>
              <ActionButton
                disabled={busy}
                onClick={() =>
                  triggerEndpoint('/api/admin/boris/test-morning?dryRun=true')
                }
                label="Сгенерировать утренний (dry-run)"
              />
              <ActionButton
                disabled={busy}
                variant="danger"
                onClick={() =>
                  triggerEndpoint(
                    '/api/admin/boris/test-morning?dryRun=false&force=true',
                    'Реально отправить в групповой чат?',
                  )
                }
                label="Отправить утренний сейчас"
              />
            </>
          }
        />
      )}

      {tab === 'self_analysis' && (
        <BriefingsTab
          briefings={briefingsSelfAnalysis}
          emptyHint="Самоанализа пока нет. Запусти dry-run, чтобы посмотреть формат сообщения."
          actions={
            <>
              <ActionButton
                disabled={busy}
                onClick={() =>
                  triggerEndpoint(
                    '/api/admin/boris/test-self-analysis?dryRun=true',
                  )
                }
                label="Сгенерировать самоанализ (dry-run)"
              />
              <ActionButton
                disabled={busy}
                variant="danger"
                onClick={() =>
                  triggerEndpoint(
                    '/api/admin/boris/test-self-analysis?dryRun=false&force=true',
                    'Реально отправить Артёму?',
                  )
                }
                label="Отправить самоанализ сейчас"
              />
            </>
          }
        />
      )}

      {tab === 'metrics' && <MetricsTab metrics={metricsWeek} />}
    </div>
  )
}

// ============================================================
// Sub-components
// ============================================================

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 px-4 py-2 rounded-pill text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap',
        active ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:text-fg',
      )}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  )
}

function ActionButton({
  onClick,
  label,
  disabled,
  variant = 'default',
}: {
  onClick: () => void
  label: string
  disabled?: boolean
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
      {label}
    </button>
  )
}

function BriefingsTab({
  briefings,
  emptyHint,
  actions,
}: {
  briefings: SerializedBriefing[]
  emptyHint: string
  actions: React.ReactNode
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">{actions}</div>

      {briefings.length === 0 ? (
        <div
          className="rounded-2xl bg-surface border border-border p-8 text-center"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <p className="text-sm text-fg-muted">{emptyHint}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {briefings.map((b) => (
            <BriefingCard key={b.id} briefing={b} />
          ))}
        </ul>
      )}
    </div>
  )
}

function BriefingCard({ briefing }: { briefing: SerializedBriefing }) {
  return (
    <li
      className="rounded-2xl bg-surface border border-border p-4 space-y-3"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg">
          {formatDateTimeMsk(briefing.generatedAt)}
        </span>
        {briefing.isDryRun && <Chip label="dry-run" tone="warning" />}
        {!briefing.sentToTg && !briefing.isDryRun && (
          <Chip label="не отправлено" tone="danger" />
        )}
        {briefing.sentToTg && <Chip label="отправлено в TG" tone="success" />}
        {briefing.recipient && (
          <Chip label={`получатель: ${briefing.recipient.name}`} tone="neutral" />
        )}
        <Chip
          label={`$${briefing.costUsd.toFixed(4)}`}
          tone="neutral"
        />
        <Chip
          label={`in ${briefing.inputTokens} / out ${briefing.outputTokens} tok`}
          tone="neutral"
        />
      </div>

      {briefing.errorMessage && (
        <div className="text-xs text-red-600 bg-red-500/5 border border-red-500/20 rounded-md p-2">
          {briefing.errorMessage}
        </div>
      )}

      {/*
        Контент рендерится как plain text внутри <pre>. HTML-теги (<b>, <i>),
        если LLM их вернёт для TG, отобразятся как текст — это допустимо для
        админ-инспектора (DOMPurify в проекте нет, ставить пакет не разрешено).
      */}
      <pre className="whitespace-pre-wrap break-words font-sans text-sm text-fg leading-relaxed">
        {briefing.content}
      </pre>
    </li>
  )
}

function Chip({
  label,
  tone,
}: {
  label: string
  tone: 'neutral' | 'success' | 'warning' | 'danger'
}) {
  const toneCls =
    tone === 'success'
      ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20'
      : tone === 'warning'
        ? 'bg-amber-500/10 text-amber-700 border-amber-500/20'
        : tone === 'danger'
          ? 'bg-red-500/10 text-red-700 border-red-500/20'
          : 'bg-fg/5 text-fg-muted border-border'
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border',
        toneCls,
      )}
    >
      {label}
    </span>
  )
}

function MetricsTab({ metrics }: { metrics: WeeklyMetricsSummary }) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-fg-muted">За последние 7 дней.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Всего вызовов"
          value={String(metrics.totalCalls)}
        />
        <MetricCard
          label="Стоимость, $"
          value={`$${metrics.totalCostUsd.toFixed(4)}`}
        />
        <MetricCard
          label="Доля ошибок"
          value={`${metrics.errorRate.toFixed(1)}%`}
        />
        <MetricCard
          label="Токены (in / out)"
          value={`${metrics.totalInputTokens} / ${metrics.totalOutputTokens}`}
        />
      </div>

      <div
        className="rounded-2xl bg-surface border border-border p-4"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <h3 className="text-base font-semibold text-fg mb-3">
          Топ инструментов (ACTION_EXECUTOR)
        </h3>
        {metrics.topTools.length === 0 ? (
          <p className="text-sm text-fg-muted">
            За последние 7 дней Action-Борис не вызывал инструменты.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {metrics.topTools.map((t) => (
              <li
                key={t.toolName}
                className="flex items-center justify-between py-2 text-sm"
              >
                <span className="font-mono text-fg">{t.toolName}</span>
                <span className="text-fg-muted">{t.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-2xl bg-surface border border-border p-4"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="text-xs text-fg-muted mb-1">{label}</div>
      <div className="text-2xl font-bold tracking-tight text-fg">{value}</div>
    </div>
  )
}
