'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquare, Save, X, Link as LinkIcon, Copy, ChevronDown, ChevronUp, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { updateClientMaxChatId, ensureClientOnboardingToken } from '../actions'
import { formatDateTimeMsk } from '@/lib/utils/format'

interface Props {
  clientId: string
  currentValue: string | null
  onboardingToken: string | null
  onboardedAt: Date | string | null
}

export function MaxChatIdSection({ clientId, currentValue, onboardingToken, onboardedAt }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [deeplink, setDeeplink] = useState(
    onboardingToken ? `https://max.ru/id503018232259_bot?start=${onboardingToken}` : null
  )
  const [manualOpen, setManualOpen] = useState(false)
  const [manualValue, setManualValue] = useState(currentValue ?? '')

  function handleGenerate() {
    startTransition(async () => {
      const r = await ensureClientOnboardingToken(clientId)
      if (r.ok) {
        setDeeplink(r.data.deeplink)
        toast.success('Ссылка готова — отправь клиенту')
      } else {
        toast.error(r.error)
      }
    })
  }

  function handleCopy() {
    if (!deeplink) return
    navigator.clipboard.writeText(deeplink)
      .then(() => toast.success('Ссылка скопирована'))
      .catch(() => toast.error('Не удалось скопировать'))
  }

  function handleUnbind() {
    if (!confirm('Отвязать chat_id? Клиент сможет привязаться заново по той же ссылке.')) return
    startTransition(async () => {
      const r = await updateClientMaxChatId(clientId, null)
      if (r.ok) {
        toast.success('chat_id отвязан')
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  function handleManualSave() {
    const next = manualValue.trim() || null
    startTransition(async () => {
      const r = await updateClientMaxChatId(clientId, next)
      if (r.ok) {
        toast.success(next ? `Привязан chat_id: ${next}` : 'chat_id отвязан')
        setManualOpen(false)
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <div
      id="max-chat-id-section"
      className="rounded-xl bg-surface border border-border p-4 mb-5 scroll-mt-24"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare className="w-4 h-4 text-brand-green" />
        <h3 className="font-display text-xs font-bold uppercase tracking-wider text-fg-muted">MAX-бот</h3>
      </div>

      {currentValue ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-xl bg-success-bg border border-success/20 p-3">
            <CheckCircle2 className="w-4 h-4 text-success-fg shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-success-fg">
                Привязан · chat_id <span className="font-mono tabular-nums">{currentValue}</span>
              </p>
              {onboardedAt && (
                <p className="text-xs text-success-fg/80 mt-0.5">
                  Подключение: {formatDateTimeMsk(onboardedAt)}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={handleUnbind}
              disabled={isPending}
              style={{ touchAction: 'manipulation' }}
              className="shrink-0 min-h-[36px] px-3 py-1.5 rounded-pill border border-danger/30 text-danger-fg text-xs font-medium hover:bg-danger-bg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              Отвязать
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {deeplink ? (
            <div className="space-y-2">
              <p className="text-sm text-fg-muted">
                Отправьте эту ссылку клиенту. После клика бот сам привяжется к чату.
              </p>
              <div className="flex items-center gap-2 rounded-xl bg-surface-2 border border-border px-3 py-2">
                <LinkIcon className="w-3.5 h-3.5 text-fg-muted shrink-0" />
                <code className="text-xs font-mono flex-1 truncate" title={deeplink}>
                  {deeplink}
                </code>
                <button
                  type="button"
                  onClick={handleCopy}
                  style={{ touchAction: 'manipulation' }}
                  className="shrink-0 inline-flex items-center gap-1 min-h-[36px] px-2.5 py-1 rounded-pill bg-surface border border-border-strong text-xs hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                >
                  <Copy className="w-3 h-3" />
                  Копировать
                </button>
              </div>
              <a
                href={deeplink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-xs text-brand-green font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
              >
                Открыть ссылку →
              </a>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm text-fg-muted">Клиент ещё не привязан к боту.</p>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={isPending}
                style={{ touchAction: 'manipulation', background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }}
                className="inline-flex items-center gap-1.5 min-h-[44px] px-5 py-2.5 rounded-pill bg-primary text-primary-foreground text-xs font-medium hover:opacity-95 transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1"
              >
                <LinkIcon className="w-3.5 h-3.5" />
                {isPending ? 'Генерируем…' : 'Получить ссылку для онбординга'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Ручной ввод chat_id — fallback на случай если deeplink не сработал */}
      <div className="mt-4 pt-4 border-t border-border">
        <button
          type="button"
          onClick={() => setManualOpen((v) => !v)}
          aria-expanded={manualOpen}
          style={{ touchAction: 'manipulation' }}
          className="text-xs text-fg-muted hover:text-fg flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          {manualOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          Расширенные настройки (ручной chat_id)
        </button>
        {manualOpen && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <input
              type="text"
              inputMode="numeric"
              pattern="\d*"
              placeholder="123456789"
              value={manualValue}
              onChange={(e) => setManualValue(e.target.value)}
              disabled={isPending}
              className="flex-1 min-w-[160px] min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors text-sm font-mono tabular-nums"
            />
            <button
              type="button"
              onClick={handleManualSave}
              disabled={isPending}
              style={{ touchAction: 'manipulation', background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-5 py-2.5 rounded-pill bg-primary text-primary-foreground text-xs font-medium hover:opacity-95 transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1"
            >
              <Save className="w-3.5 h-3.5" />
              Сохранить
            </button>
            <button
              type="button"
              onClick={() => {
                setManualOpen(false)
                setManualValue(currentValue ?? '')
              }}
              disabled={isPending}
              style={{ touchAction: 'manipulation' }}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3 py-2.5 rounded-xl text-fg-muted text-xs hover:text-fg hover:bg-surface-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              <X className="w-3.5 h-3.5" />
              Отмена
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
