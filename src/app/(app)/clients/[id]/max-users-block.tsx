'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Users, X, Copy, Trash2, BadgeCheck } from 'lucide-react'
import { toast } from 'sonner'
import { formatDateTimeMsk } from '@/lib/utils/format'
import {
  createMaxInvite,
  revokeMaxInvite,
  promoteMaxUserManually,
  deleteMaxUser,
} from '../max-users-actions'

export interface MaxUser {
  id: string
  chatId: string
  username: string | null
  isActive: boolean
  // Даты приходят как Date (serialize сохраняет тип) — парсятся через new Date().
  lastSeenAt: string | Date | null
  linkedAt: string | Date
}

export interface PendingInvite {
  id: string
  phone: string
  label: string | null
  token: string
  expiresAt: string | Date
  createdAt: string | Date
}

interface Props {
  clientId: string
  users: MaxUser[]
  invites: PendingInvite[]
  botUsername: string
}

function inviteUrl(botUsername: string, token: string): string {
  return `https://max.ru/${botUsername}?start=${token}`
}

/** Текст «последний раз писал», цвет-маркер для молчания > 21 дня. */
function lastSeenInfo(lastSeenAt: string | Date | null): { text: string; danger: boolean; muted: boolean } {
  if (!lastSeenAt) {
    return { text: 'Ещё не писал', danger: false, muted: true }
  }
  const ts = new Date(lastSeenAt).getTime()
  if (Number.isNaN(ts)) {
    return { text: 'Ещё не писал', danger: false, muted: true }
  }
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days > 21) {
    return { text: `Молчит ${days}+ дней`, danger: true, muted: false }
  }
  if (days <= 0) {
    return { text: 'Последний раз: сегодня', danger: false, muted: true }
  }
  return { text: `Последний раз: ${days} дн. назад`, danger: false, muted: true }
}

async function copyToClipboard(text: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(successMessage)
  } catch {
    toast.error('Не удалось скопировать ссылку')
  }
}

export function MaxUsersBlock({ clientId, users, invites, botUsername }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [modalOpen, setModalOpen] = useState(false)

  const isEmpty = users.length === 0 && invites.length === 0

  function handlePromote(chatId: string) {
    startTransition(async () => {
      const result = await promoteMaxUserManually(clientId, chatId)
      if (result.ok) {
        toast.success('Пользователь стал активным')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleDeleteUser(chatId: string) {
    if (!window.confirm('Удалить привязку этого пользователя?')) return
    startTransition(async () => {
      const result = await deleteMaxUser(clientId, chatId)
      if (result.ok) {
        toast.success('Привязка удалена')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleRevoke(inviteId: string) {
    if (!window.confirm('Отозвать это приглашение?')) return
    startTransition(async () => {
      const result = await revokeMaxInvite(inviteId)
      if (result.ok) {
        toast.success('Приглашение отозвано')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div
      id="max-users-section"
      className="rounded-xl bg-surface border border-border p-4 mb-5 scroll-mt-24"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-center gap-2 mb-3">
        <Users className="w-4 h-4 text-fg-muted shrink-0" />
        <h3 className="font-display text-xs uppercase tracking-wider text-fg-muted font-bold">
          MAX-пользователи
        </h3>
      </div>

      {/* 1) Пусто — нет ни привязок, ни инвайтов */}
      {isEmpty && (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">
            У клиента нет MAX-привязок — бот не сможет ему писать. Добавьте пользователя через
            ссылку-приглашение.
          </p>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            style={{
              touchAction: 'manipulation',
              background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)',
              boxShadow: 'var(--shadow-capsule)',
            }}
            className="min-h-[44px] px-5 py-2.5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            Добавить пользователя
          </button>
        </div>
      )}

      {/* 2) Список пользователей */}
      {users.length >= 1 && (
        <div className="space-y-2">
          <ul className="space-y-2">
            {users.map((user) => {
              const seen = lastSeenInfo(user.lastSeenAt)
              return (
                <li
                  key={user.id}
                  className="rounded-xl border border-border bg-surface-2/40 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {user.username ? (
                          <span className="text-sm font-medium text-fg truncate">
                            @{user.username}
                          </span>
                        ) : (
                          <span className="text-sm font-medium text-fg tabular-nums font-mono truncate">
                            chat_id {user.chatId}
                          </span>
                        )}
                        {user.isActive ? (
                          <span className="inline-flex items-center gap-1 rounded-pill bg-success-bg text-success-fg text-xs font-medium px-2 py-0.5">
                            🟢 Активный
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-pill bg-surface-2 text-fg-muted text-xs font-medium px-2 py-0.5">
                            ⚪ Запасной
                          </span>
                        )}
                      </div>
                      <p
                        className={
                          seen.danger
                            ? 'mt-1 text-xs font-medium text-danger-fg'
                            : 'mt-1 text-xs text-fg-subtle'
                        }
                      >
                        {seen.text}
                      </p>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {!user.isActive && (
                      <button
                        type="button"
                        onClick={() => handlePromote(user.chatId)}
                        disabled={isPending}
                        style={{ touchAction: 'manipulation' }}
                        className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-xs hover:bg-surface-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                      >
                        <BadgeCheck className="w-3.5 h-3.5" />
                        Сделать активным
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDeleteUser(user.chatId)}
                      disabled={isPending}
                      style={{ touchAction: 'manipulation' }}
                      className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill border border-border bg-surface text-danger-fg font-medium text-xs hover:bg-danger-bg transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Удалить привязку
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>

          <button
            type="button"
            onClick={() => setModalOpen(true)}
            style={{ touchAction: 'manipulation' }}
            className="min-h-[36px] inline-flex items-center px-3 py-1.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-xs hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            Добавить ещё пользователя
          </button>
        </div>
      )}

      {/* 3) Ожидают захода */}
      {invites.length >= 1 && (
        <div className={users.length >= 1 ? 'mt-4 pt-4 border-t border-border' : ''}>
          <h4 className="text-xs uppercase tracking-wide font-bold text-fg-subtle mb-2">
            Ожидают захода
          </h4>
          <ul className="space-y-2">
            {invites.map((invite) => (
              <li
                key={invite.id}
                className="rounded-xl border border-border bg-surface-2/30 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg truncate">
                      {invite.label || invite.phone}
                    </p>
                    {invite.label && (
                      <p className="text-xs text-fg-subtle truncate">{invite.phone}</p>
                    )}
                    <p className="mt-1 text-xs text-fg-subtle">
                      действует до {formatDateTimeMsk(invite.expiresAt)}
                    </p>
                  </div>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(
                        inviteUrl(botUsername, invite.token),
                        'Ссылка скопирована'
                      )
                    }
                    style={{ touchAction: 'manipulation' }}
                    className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-xs hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    Скопировать ссылку
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRevoke(invite.id)}
                    disabled={isPending}
                    style={{ touchAction: 'manipulation' }}
                    className="min-h-[36px] inline-flex items-center px-3 py-1.5 rounded-pill border border-border bg-surface text-danger-fg font-medium text-xs hover:bg-danger-bg transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  >
                    Отозвать
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <AddMaxUserModal
        clientId={clientId}
        botUsername={botUsername}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </div>
  )
}

interface ModalProps {
  clientId: string
  botUsername: string
  open: boolean
  onClose: () => void
}

function AddMaxUserModal({ clientId, open, onClose }: ModalProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [phone, setPhone] = useState('')
  const [label, setLabel] = useState('')
  const [resultUrl, setResultUrl] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setPhone('')
      setLabel('')
      setResultUrl(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  function handleGenerate(e: React.FormEvent) {
    e.preventDefault()
    if (phone.trim().length < 5) {
      toast.error('Укажите номер телефона')
      return
    }
    startTransition(async () => {
      const result = await createMaxInvite(clientId, phone.trim(), label.trim() || null)
      if (result.ok) {
        setResultUrl(result.data.url)
        toast.success('Ссылка-приглашение готова')
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleDone() {
    onClose()
    router.refresh()
  }

  const inputClass =
    'w-full min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-brand-green focus:ring-1 focus:ring-brand-green/30 transition-colors'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-fg/30 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl bg-surface border border-border"
        style={{ boxShadow: 'var(--shadow-popover)' }}
      >
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-display text-lg font-bold text-fg-strong">
            Добавить пользователя MAX
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            style={{ touchAction: 'manipulation' }}
            className="min-h-[44px] min-w-[44px] w-11 h-11 -mr-2 rounded-full hover:bg-surface-2 flex items-center justify-center text-fg-muted hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {resultUrl === null ? (
          <form onSubmit={handleGenerate} className="p-5 space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">
                Номер телефона <span className="text-danger-fg">*</span>
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+7 (999) 999-99-99"
                autoFocus
                className={inputClass}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">
                Имя (опционально)
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="прораб, бухгалтер"
                className={inputClass}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isPending}
                style={{ touchAction: 'manipulation' }}
                className="min-h-[44px] px-5 py-2.5 rounded-xl border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-surface-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={isPending}
                style={{
                  touchAction: 'manipulation',
                  background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)',
                  boxShadow: 'var(--shadow-capsule)',
                }}
                className="min-h-[44px] px-5 py-2.5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                {isPending ? 'Генерируем…' : 'Сгенерировать ссылку'}
              </button>
            </div>
          </form>
        ) : (
          <div className="p-5 space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs uppercase tracking-wide font-bold text-fg-muted">
                Ссылка-приглашение
              </label>
              <div className="flex items-stretch gap-2">
                <input
                  type="text"
                  value={resultUrl}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 min-w-0 min-h-[44px] px-3 py-2.5 rounded-xl bg-surface-2 border border-border text-fg-muted text-sm focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => copyToClipboard(resultUrl, 'Ссылка скопирована')}
                  aria-label="Скопировать ссылку"
                  style={{ touchAction: 'manipulation' }}
                  className="min-h-[44px] min-w-[44px] px-3 inline-flex items-center justify-center rounded-xl border border-border-strong bg-surface text-fg hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>

            <p className="text-sm text-fg-muted">
              Отправьте эту ссылку сотруднику клиента. Когда он перейдёт по ней в MAX, привязка
              активируется. Ссылка одноразовая и действует 7 дней.
            </p>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={handleDone}
                style={{
                  touchAction: 'manipulation',
                  background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)',
                  boxShadow: 'var(--shadow-capsule)',
                }}
                className="min-h-[44px] px-5 py-2.5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                Готово
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
