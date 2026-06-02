'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { AlertCircle, Loader2, CheckCircle2, Circle } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { getInvoiceProgress } from '../actions'
import { INVOICE_PROGRESS_STAGES } from '@/lib/invoices/progress-labels'
import type { InvoiceProgress, InvoiceStatus } from '@prisma/client'

interface Props {
  invoiceId: string
  initialProgress: InvoiceProgress
  initialStatus: InvoiceStatus
  initialErrorMessage: string | null
}

export function ProgressView({
  invoiceId,
  initialProgress,
  initialStatus,
  initialErrorMessage,
}: Props) {
  const [progress, setProgress] = useState<InvoiceProgress>(initialProgress)
  const [errorMessage, setErrorMessage] = useState<string | null>(initialErrorMessage)
  const router = useRouter()
  // prev !== null означает что был хотя бы один effect-цикл; toast пуляем только
  // при реальной смене статуса во время polling-а (не при первом монтировании).
  const prevProgressRef = useRef<InvoiceProgress | null>(null)

  useEffect(() => {
    // Если уже терминальный — не запускаем интервал.
    if (initialProgress === 'READY' || initialProgress === 'FAILED') return

    let stopped = false
    const interval = setInterval(async () => {
      if (stopped) return
      const r = await getInvoiceProgress(invoiceId)
      if (!r.ok || stopped) return
      setProgress(r.data.progress)
      setErrorMessage(r.data.aiErrorMessage)
      if (r.data.progress === 'READY' || r.data.progress === 'FAILED') {
        stopped = true
        clearInterval(interval)
        // На READY page.tsx должен подгрузить полные данные накладной — refresh.
        if (r.data.progress === 'READY') router.refresh()
      }
    }, 2000)

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [invoiceId, initialProgress, router])

  // Toast при реальном переходе из НЕ-READY в READY (polling завершил пайплайн
  // на глазах у пользователя).
  useEffect(() => {
    const prev = prevProgressRef.current
    prevProgressRef.current = progress
    if (prev !== null && prev !== 'READY' && progress === 'READY') {
      toast.success('Поставка распознана')
    }
  }, [progress])

  const isFailed = progress === 'FAILED' || initialStatus === 'FAILED'
  const isReady = progress === 'READY'
  const currentIndex = INVOICE_PROGRESS_STAGES.findIndex((s) => s.key === progress)

  return (
    <div className="space-y-6">
      {/* Прогресс-блок этапов — только во время активного распознавания.
          После READY страница перезагрузится в InvoiceView; после FAILED
          показывается блок с ошибкой и retry. */}
      {!isReady && !isFailed && (
        <div
          className="max-w-2xl bg-surface border border-border rounded-2xl p-6"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <ol className="space-y-3">
            {INVOICE_PROGRESS_STAGES.map((stage, i) => {
              let state: 'done' | 'active' | 'pending'
              if (i < currentIndex) state = 'done'
              else if (i === currentIndex) state = 'active'
              else state = 'pending'

              return (
                <li key={stage.key} className="flex items-center gap-3">
                  <StageIcon state={state} />
                  <span
                    className={cn(
                      'text-sm',
                      state === 'done' && 'text-fg-muted',
                      state === 'active' && 'text-fg font-medium',
                      state === 'pending' && 'text-fg-subtle',
                    )}
                  >
                    {stage.label}
                  </span>
                </li>
              )
            })}
          </ol>
          <p className="mt-5 text-xs text-fg-subtle">
            Обработка обычно занимает до минуты. Можно закрыть страницу — распознавание продолжится в фоне.
          </p>
        </div>
      )}

      {isFailed && (
        <div className="max-w-2xl rounded-2xl border border-danger/30 bg-danger/5 p-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-6 h-6 text-danger shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-fg mb-1">Не удалось распознать поставку</p>
              <p className="text-sm text-fg-muted mb-4 whitespace-pre-wrap">
                {errorMessage ?? 'Причина неизвестна. Проверьте логи сервера.'}
              </p>
              <div className="flex gap-3">
                <Link
                  href="/invoices"
                  className="inline-flex px-5 py-2.5 rounded-pill border border-border text-fg text-sm hover:bg-fg/5 transition-colors"
                >
                  К списку
                </Link>
                <Link
                  href="/invoices/new"
                  className="inline-flex px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity"
                >
                  Загрузить новую
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StageIcon({ state }: { state: 'done' | 'active' | 'pending' }) {
  if (state === 'done') return <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
  if (state === 'active') return <Loader2 className="w-5 h-5 text-accent shrink-0 animate-spin" />
  return <Circle className="w-5 h-5 text-fg-subtle shrink-0" strokeWidth={1.5} />
}
