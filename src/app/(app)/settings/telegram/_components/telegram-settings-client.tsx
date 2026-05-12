'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Send, Link as LinkIcon, Copy, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { generateTelegramOnboardingToken, unlinkTelegram } from '@/lib/telegram/actions'

interface Props {
  isLinked: boolean
  telegramUsername: string | null
  initialDeeplink: string | null
  initialDeeplinkExpiresAt: string | null
}

function formatRemaining(expiresAtIso: string): string {
  const ms = new Date(expiresAtIso).getTime() - Date.now()
  if (ms <= 0) return 'истекла'
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'меньше минуты'
  return `${min} мин`
}

export function TelegramSettingsClient({
  isLinked,
  telegramUsername,
  initialDeeplink,
  initialDeeplinkExpiresAt,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [deeplink, setDeeplink] = useState<string | null>(initialDeeplink)
  const [expiresAt, setExpiresAt] = useState<string | null>(initialDeeplinkExpiresAt)
  const [unlinkOpen, setUnlinkOpen] = useState(false)

  function handleGenerate() {
    startTransition(async () => {
      try {
        const result = await generateTelegramOnboardingToken()
        setDeeplink(result.deeplink)
        setExpiresAt(result.expiresAt)
        toast.success('Ссылка готова — открой в Telegram')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Не удалось сгенерировать ссылку'
        toast.error(message)
      }
    })
  }

  function handleCopy() {
    if (!deeplink) return
    navigator.clipboard
      .writeText(deeplink)
      .then(() => toast.success('Ссылка скопирована'))
      .catch(() => toast.error('Не удалось скопировать'))
  }

  function handleUnlink() {
    startTransition(async () => {
      try {
        await unlinkTelegram()
        toast.success('Telegram отвязан')
        setDeeplink(null)
        setExpiresAt(null)
        setUnlinkOpen(false)
        router.refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Не удалось отвязать'
        toast.error(message)
      }
    })
  }

  if (isLinked) {
    return (
      <div
        className="rounded-2xl bg-surface border border-border p-5"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <div className="flex items-center gap-2 mb-4">
          <Send className="w-4 h-4 text-fg-muted" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">
            Telegram привязан
          </h3>
        </div>

        <div className="flex items-start gap-2 rounded-xl bg-success-bg/30 border border-success/20 p-3">
          <CheckCircle2 className="w-4 h-4 text-success-fg shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-success-fg">
              Уведомления приходят в Telegram{' '}
              {telegramUsername ? (
                <span className="font-medium">@{telegramUsername}</span>
              ) : (
                <span className="text-success-fg/80">(без username)</span>
              )}
            </p>
          </div>

          <AlertDialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                disabled={isPending}
                className="shrink-0 px-3 py-1.5 rounded-pill border border-danger/30 text-danger-fg text-xs font-medium hover:bg-danger-bg/40 disabled:opacity-50"
              >
                Отвязать
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Отвязать Telegram?</AlertDialogTitle>
                <AlertDialogDescription>
                  Уведомления перестанут приходить в Telegram. Чтобы получать их снова, потребуется
                  заново сгенерировать ссылку и активировать её в боте.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPending}>Отмена</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={(e) => {
                    e.preventDefault()
                    handleUnlink()
                  }}
                  disabled={isPending}
                >
                  Отвязать
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    )
  }

  // State A — не привязан
  return (
    <div
      className="rounded-2xl bg-surface border border-border p-5"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-center gap-2 mb-4">
        <Send className="w-4 h-4 text-fg-muted" />
        <h3 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">
          Telegram-уведомления
        </h3>
      </div>

      <div className="space-y-3">
        <p className="text-sm text-fg-muted">
          Привяжите Telegram, чтобы получать сводки и срочные уведомления о клиентах.
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

            <div className="flex flex-wrap items-center gap-2">
              <a
                href={deeplink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-pill bg-accent text-accent-fg text-xs font-medium hover:opacity-90"
              >
                <LinkIcon className="w-3.5 h-3.5" />
                Открыть в Telegram
              </a>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-pill border border-border-strong text-xs font-medium hover:bg-bg disabled:opacity-50"
              >
                {isPending ? 'Генерируем…' : 'Сгенерировать новую'}
              </button>
            </div>

            <p className="text-xs text-fg-subtle">
              Откройте ссылку в Telegram. Бот привяжет аккаунт автоматически.{' '}
              {expiresAt && <>Ссылка действует ещё {formatRemaining(expiresAt)} (всего 30 минут).</>}
            </p>
          </>
        ) : (
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill bg-accent text-accent-fg text-xs font-medium hover:opacity-90 disabled:opacity-50"
          >
            <LinkIcon className="w-3.5 h-3.5" />
            {isPending ? 'Генерируем…' : 'Сгенерировать ссылку'}
          </button>
        )}
      </div>
    </div>
  )
}
