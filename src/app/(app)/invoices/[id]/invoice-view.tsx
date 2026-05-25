'use client'

import { useState, useTransition } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, Loader2, CheckCircle2, X, RotateCcw, AlertCircle } from 'lucide-react'
import type { InvoiceConfidence, InvoiceMatchAction, PriceChangeLevel, UserRole } from '@prisma/client'
import { cn } from '@/lib/utils/cn'
import { formatMoneyRu } from '@/lib/digest/format'
import { formatDateLong, formatDateTimeMsk } from '@/lib/utils/format'
import { isAdminPro } from '@/lib/auth/role-helpers'
import { InvoiceStatusChip } from '@/lib/invoices/status-chip'
import { acceptInvoice } from '../admin-actions'
import { FailedState } from './failed-state'
// Эти компоненты создаёт Subagent C — на момент сборки A.4 их может ещё не быть,
// tsc будет ругаться (это ожидаемо параллельно).
import { RejectDialog } from './reject-dialog'
import { RevertDialog } from './revert-dialog'
import { BboxOverlay } from './bbox-overlay'

// ------------------------- input shape -------------------------------------
// page.tsx передаёт serialize(invoice) — Decimal становится number, Date остаётся Date.
// Явно описываем shape без зависимости от Prisma-типа (serialize рекурсивно меняет
// Decimal на number и tsc не должен путаться).

interface SerializedLine {
  id: string
  lineIndex: number
  rawName: string
  rawQuantity: number
  rawUnit: string
  rawPricePerUnit: number
  rawAmount: number
  matchedIngredientId: string | null
  matchedIngredient: { id: string; name: string } | null
  matchedAction: InvoiceMatchAction
  aiConfidence: InvoiceConfidence
  aiContext: string | null
  pricePerKgNormalized: number | null
  previousPricePerKg: number | null
  priceChangePercent: number | null
  priceChangeLevel: PriceChangeLevel
  boundingBoxes: unknown
}

interface SerializedInvoice {
  id: string
  supplierName: string
  invoiceNumber: string
  invoiceDate: Date
  receivedAt: Date
  receivedById: string
  receivedBy: { id: string; name: string }
  acceptedById: string | null
  acceptedBy: { id: string; name: string } | null
  acceptedAt: Date | null
  revertedById: string | null
  revertedBy: { id: string; name: string } | null
  revertedAt: Date | null
  imageUrl: string
  imageWidth: number | null
  imageHeight: number | null
  exifTakenAt: Date | null
  exifSuspicious: boolean
  status: 'PROCESSING' | 'AWAITING_ACCEPT' | 'ACCEPTED' | 'REJECTED' | 'REVERTED' | 'FAILED'
  aiErrorMessage: string | null
  totalAmount: number | null
  lines: SerializedLine[]
}

interface Props {
  invoice: SerializedInvoice
  currentUserRole: UserRole
}

export function InvoiceView({ invoice, currentUserRole }: Props) {
  const router = useRouter()
  const [isAccepting, startAccept] = useTransition()
  const [rejectOpen, setRejectOpen] = useState(false)
  const [revertOpen, setRevertOpen] = useState(false)
  const [hoveredLineId, setHoveredLineId] = useState<string | null>(null)

  const adminPro = isAdminPro(currentUserRole)
  const isAwaiting = invoice.status === 'AWAITING_ACCEPT'
  const isAccepted = invoice.status === 'ACCEPTED'
  const isFailed = invoice.status === 'FAILED'

  function onAccept() {
    startAccept(async () => {
      const r = await acceptInvoice(invoice.id)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      toast.success('Накладная принята')
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex flex-col gap-3">
        <Link
          href="/invoices"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg w-fit"
        >
          <ArrowLeft className="w-4 h-4" />
          К списку
        </Link>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div className="space-y-1">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              {invoice.supplierName}
            </h1>
            <p className="text-sm text-fg-muted">
              № {invoice.invoiceNumber} · {formatDateLong(invoice.invoiceDate)}
            </p>
          </div>
          <InvoiceStatusChip status={invoice.status} className="mt-1" />
        </div>

        {/* Audit */}
        <div className="text-xs text-fg-subtle space-y-0.5">
          <p>
            Загрузил {invoice.receivedBy.name} · {formatDateTimeMsk(invoice.receivedAt)}
          </p>
          {invoice.acceptedBy && invoice.acceptedAt && (
            <p>
              Принял {invoice.acceptedBy.name} · {formatDateTimeMsk(invoice.acceptedAt)}
            </p>
          )}
          {invoice.revertedBy && invoice.revertedAt && (
            <p>
              Откатил {invoice.revertedBy.name} · {formatDateTimeMsk(invoice.revertedAt)}
            </p>
          )}
          {invoice.exifSuspicious && (
            <p className="text-warning-fg flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              EXIF подозрительный — фото может быть не свежее
            </p>
          )}
        </div>
      </header>

      {/* FAILED — общий компонент FailedState (с retry + ссылкой на оригинал фото). */}
      {isFailed && (
        <FailedState
          invoiceId={invoice.id}
          errorMessage={invoice.aiErrorMessage}
          imageUrl={invoice.imageUrl || null}
          userRole={currentUserRole}
        />
      )}

      {/* Grid: фото слева, строки справа */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Левая колонка — фото */}
        <div className="lg:sticky lg:top-6 lg:self-start space-y-3">
          <a
            href={invoice.imageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block relative rounded-2xl border border-border overflow-hidden bg-surface"
          >
            {invoice.imageUrl ? (
              <Image
                src={invoice.imageUrl}
                alt={`Накладная ${invoice.supplierName} № ${invoice.invoiceNumber}`}
                width={invoice.imageWidth ?? 1600}
                height={invoice.imageHeight ?? 2000}
                className="w-full h-auto"
                sizes="(max-width: 1024px) 100vw, 50vw"
              />
            ) : (
              <div className="aspect-[3/4] flex items-center justify-center text-fg-subtle text-sm">
                Фото удалено
              </div>
            )}
            {invoice.imageUrl && (
              <BboxOverlay
                lines={invoice.lines}
                imageWidth={invoice.imageWidth ?? 1600}
                imageHeight={invoice.imageHeight ?? 2000}
                hoveredLineId={hoveredLineId}
              />
            )}
          </a>
          {invoice.totalAmount !== null && (
            <div className="text-sm text-fg-muted">
              Итого: <span className="font-semibold text-fg">{formatMoneyRu(invoice.totalAmount)}</span>
            </div>
          )}
        </div>

        {/* Правая колонка — строки */}
        <div className="space-y-3">
          {invoice.lines.length === 0 ? (
            <div className="rounded-2xl border border-border bg-surface p-6 text-sm text-fg-muted text-center">
              В накладной нет распознанных позиций.
            </div>
          ) : (
            invoice.lines.map((line) => (
              <InvoiceLineCard
                key={line.id}
                line={line}
                isHovered={hoveredLineId === line.id}
                onHoverChange={(h) => setHoveredLineId(h ? line.id : null)}
              />
            ))
          )}
        </div>
      </div>

      {/* Sticky bottom bar / inline actions */}
      {(isAwaiting || isAccepted) && (
        <div
          className={cn(
            'sticky bottom-0 -mx-4 px-4 py-3 bg-surface/95 backdrop-blur border-t border-border',
            'md:static md:mx-0 md:px-0 md:py-0 md:bg-transparent md:backdrop-blur-none md:border-0',
          )}
        >
          <div className="flex flex-col-reverse md:flex-row md:items-center gap-2 md:gap-3">
            {isAwaiting && (
              <>
                <button
                  type="button"
                  onClick={onAccept}
                  disabled={!adminPro || isAccepting}
                  title={!adminPro ? 'Только Администратор PRO' : undefined}
                  className="px-5 py-2.5 rounded-pill bg-success text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isAccepting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  Принять
                </button>
                <button
                  type="button"
                  onClick={() => setRejectOpen(true)}
                  disabled={!adminPro}
                  title={!adminPro ? 'Только Администратор PRO' : undefined}
                  className="px-5 py-2.5 rounded-pill border border-border text-fg text-sm hover:bg-fg/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <X className="w-4 h-4" />
                  Отклонить
                </button>
              </>
            )}
            {isAccepted && (
              <button
                type="button"
                onClick={() => setRevertOpen(true)}
                disabled={!adminPro}
                title={!adminPro ? 'Только Администратор PRO' : undefined}
                className="px-5 py-2.5 rounded-pill border border-danger/30 bg-danger/5 text-danger-fg text-sm hover:bg-danger/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Откатить приёмку
              </button>
            )}
          </div>
        </div>
      )}

      {/* Dialogs (controlled — open/onOpenChange API от Subagent C) */}
      <RejectDialog
        invoiceId={invoice.id}
        open={rejectOpen}
        onOpenChange={setRejectOpen}
      />
      <RevertDialog
        invoiceId={invoice.id}
        open={revertOpen}
        onOpenChange={setRevertOpen}
      />
    </div>
  )
}

// ------------------------- Line card ---------------------------------------

const ACTION_STYLES: Record<InvoiceMatchAction, { label: string; cls: string }> = {
  MATCHED_EXISTING: { label: 'Сопоставлено', cls: 'bg-success-bg text-success-fg' },
  CREATED_NEW: { label: 'Новый ингредиент', cls: 'bg-info-bg text-info-fg' },
  SKIPPED: { label: 'Пропущено', cls: 'bg-fg/5 text-fg-muted' },
}

const CONFIDENCE_STYLES: Record<InvoiceConfidence, { label: string; cls: string }> = {
  HIGH: { label: 'Высокая', cls: 'bg-success-bg text-success-fg' },
  MEDIUM: { label: 'Средняя', cls: 'bg-warning-bg text-warning-fg' },
  LOW: { label: 'Низкая', cls: 'bg-danger-bg text-danger-fg' },
}

const PRICE_CHANGE_STYLES: Record<PriceChangeLevel, { label: string; cls: string }> = {
  LOW: { label: '', cls: 'bg-success-bg text-success-fg' },
  MEDIUM: { label: 'Заметно', cls: 'bg-warning-bg text-warning-fg' },
  HIGH: { label: 'Резко', cls: 'bg-danger-bg text-danger-fg' },
  NEW: { label: 'Новая цена', cls: 'bg-info-bg text-info-fg' },
}

function InvoiceLineCard({
  line,
  isHovered,
  onHoverChange,
}: {
  line: SerializedLine
  isHovered: boolean
  onHoverChange: (h: boolean) => void
}) {
  const action = ACTION_STYLES[line.matchedAction]
  const conf = CONFIDENCE_STYLES[line.aiConfidence]
  const pc = PRICE_CHANGE_STYLES[line.priceChangeLevel]
  const isLow = line.aiConfidence === 'LOW'

  return (
    <div
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      className={cn(
        'rounded-2xl border bg-surface p-4 space-y-2 transition-colors',
        isLow ? 'border-warning/30 bg-warning-bg/20' : 'border-border',
        isHovered && 'ring-2 ring-accent/30',
      )}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-fg break-words">
            {line.rawName}
          </p>
          <p className="text-sm text-fg-muted">
            {line.rawQuantity} {line.rawUnit} · {formatMoneyRu(line.rawAmount)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={cn('inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-medium', action.cls)}>
            {action.label}
          </span>
          <span className={cn('inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-medium', conf.cls)}>
            {conf.label}
          </span>
        </div>
      </div>

      {line.matchedIngredient && (
        <p className="text-sm text-fg-muted flex items-center gap-1.5">
          <ArrowRight className="w-3.5 h-3.5 shrink-0" />
          <span className="break-words">{line.matchedIngredient.name}</span>
        </p>
      )}

      {line.aiContext && (
        <p className="text-xs italic text-fg-muted whitespace-pre-wrap">
          {line.aiContext}
        </p>
      )}

      {/* Δ цены */}
      {(line.previousPricePerKg !== null || line.priceChangeLevel === 'NEW') && (
        <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border/50">
          {line.previousPricePerKg !== null && line.pricePerKgNormalized !== null ? (
            <p className="text-xs text-fg-muted">
              {formatMoneyRu(line.previousPricePerKg)} → <span className="font-medium text-fg">{formatMoneyRu(line.pricePerKgNormalized)}</span>
              {line.priceChangePercent !== null && (
                <span className="text-fg-subtle"> · {line.priceChangePercent > 0 ? '+' : ''}{line.priceChangePercent}%</span>
              )}
              <span className="text-fg-subtle"> / кг</span>
            </p>
          ) : line.pricePerKgNormalized !== null ? (
            <p className="text-xs text-fg-muted">
              <span className="font-medium text-fg">{formatMoneyRu(line.pricePerKgNormalized)}</span>
              <span className="text-fg-subtle"> / кг</span>
            </p>
          ) : null}
          {pc.label && (
            <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded-pill text-[10px] font-medium uppercase tracking-wide', pc.cls)}>
              {pc.label}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
