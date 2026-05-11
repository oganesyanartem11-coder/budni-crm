'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Link as LinkIcon, Copy, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { ensureMyOnboardingToken, unbindMyMaxChat } from './actions'

interface Props {
  currentChatId: string | null
  initialDeeplink: string | null
  onboardedAt: Date | string | null
}

export function MaxNotificationsSection({ currentChatId, initialDeeplink, onboardedAt }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [deeplink, setDeeplink] = useState<string | null>(initialDeeplink)

  function handleGenerate() {
    startTransition(async () => {
      const r = await ensureMyOnboardingToken()
      if (r.ok) {
        setDeeplink(r.data.deeplink)
        toast.success('Ссылка готова — открой в MAX')
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
    if (!confirm('Отвязать MAX от вашего аккаунта? Пуши перестанут приходить.')) return
    startTransition(async () => {
      const r = await unbindMyMaxChat()
      if (r.ok) {
        toast.success('MAX отвязан')
        setDeeplink(null)
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <div
      className="rounded-2xl bg-surface border border-border p-5"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-center gap-2 mb-4">
        <Bell className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">
          Уведомления в MAX
        </h3>
      </div>

      {currentChatId ? (
        <div className="flex items-start gap-2 rounded-xl bg-success-bg/30 border border-success/20 p-3">
          <CheckCircle2 className="w-4 h-4 text-success-fg shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-success-fg">
              MAX привязан · вы будете получать пуши о новых обращениях клиентов
            </p>
            {onboardedAt && (
              <p className="text-xs text-success-fg/80 mt-0.5">
                Подключение: {new Date(onboardedAt).toLocaleString('ru-RU')}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleUnbind}
            disabled={isPending}
            className="shrink-0 px-3 py-1.5 rounded-pill border border-danger/30 text-danger-fg text-xs font-medium hover:bg-danger-bg/40 disabled:opacity-50"
          >
            Отвязать
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">
            Привяжите свой MAX-аккаунт, чтобы получать пуши о новых обращениях клиентов в Inbox.
          </p>
          {deeplink ? (
            <>
              <div className="flex items-center gap-2 rounded-xl bg-bg/40 border border-border px-3 py-2">
                <LinkIcon className="w-3.5 h-3.5 text-fg-muted shrink-0" />
                <code className="text-xs font-mono flex-1 truncate" title={deeplink}>
                  {deeplink}
                </code>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-surface border border-border-strong text-xs hover:bg-bg"
                >
                  <Copy className="w-3 h-3" />
                  Копировать
                </button>
              </div>
              <a
                href={deeplink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-pill bg-accent text-accent-fg text-xs font-medium hover:opacity-90"
              >
                <LinkIcon className="w-3.5 h-3.5" />
                Открыть в MAX
              </a>
            </>
          ) : (
            <button
              type="button"
              onClick={handleGenerate}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill bg-accent text-accent-fg text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              <LinkIcon className="w-3.5 h-3.5" />
              {isPending ? 'Генерируем…' : 'Получить ссылку'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
