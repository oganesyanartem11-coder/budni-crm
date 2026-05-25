'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus,
  KeyRound,
  Power,
  PowerOff,
  CheckCircle2,
  Copy,
  Send,
  Link2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  createUser,
  regenerateUserPin,
  setUserActive,
  generateOnboardingTokenForUser,
  unlinkTelegramFromUser,
} from './actions'
import type { UserRole } from '@prisma/client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils/cn'
import { formatDateMsk } from '@/lib/utils/format'

interface UserRow {
  id: string
  name: string
  role: UserRole
  isActive: boolean
  createdAt: string
  onboardedAt: string | null
  telegramChatId: string | null
  telegramUsername: string | null
}

interface Props {
  users: UserRow[]
  currentUserId: string
}

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Администратор',
  MANAGER: 'Менеджер',
  CHEF: 'Шеф',
  COURIER: 'Курьер',
}

const ROLE_COLORS: Record<UserRole, string> = {
  ADMIN: 'bg-danger-bg text-danger-fg',
  MANAGER: 'bg-info-bg text-info-fg',
  CHEF: 'bg-warning-bg text-warning-fg',
  COURIER: 'bg-neutral-bg text-neutral-fg',
}

function defaultLinkTelegramFor(role: UserRole): boolean {
  return role === 'MANAGER' || role === 'ADMIN'
}

// Состояние «после успешного действия» — модалка с готовым текстом и
// раскладкой по отдельности. Используется и для создания, и для перевыдачи
// доступа Telegram (тогда pin === null), и для регенерации PIN (тогда
// deepLink === null и loginUrl === null — показываем только PIN).
interface Credentials {
  title: string
  pin: string | null
  loginUrl: string | null
  deepLink: string | null
  messageTemplate: string
}

export function UsersTable({ users, currentUserId }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Форма создания
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState<UserRole>('MANAGER')
  const [linkTelegram, setLinkTelegram] = useState<boolean>(
    defaultLinkTelegramFor('MANAGER')
  )

  // Модалка результата
  const [shownCreds, setShownCreds] = useState<Credentials | null>(null)
  const [showDetails, setShowDetails] = useState(false)

  // Подтверждение перевыдачи для уже привязанного юзера
  const [reissueTarget, setReissueTarget] = useState<UserRow | null>(null)

  function handleRoleChange(v: UserRole) {
    setRole(v)
    setLinkTelegram(defaultLinkTelegramFor(v))
  }

  function copy(text: string, okMessage: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(okMessage))
      .catch(() => toast.error('Не удалось скопировать'))
  }

  function handleCreate() {
    if (!name.trim()) {
      toast.error('Введите имя')
      return
    }
    startTransition(async () => {
      const r = await createUser({ name, role, linkTelegram })
      if (r.ok) {
        setShownCreds({
          title: `Пользователь создан: ${r.data.name}`,
          pin: r.data.pin,
          loginUrl: r.data.loginUrl,
          deepLink: r.data.deepLink,
          messageTemplate: r.data.messageTemplate,
        })
        setShowDetails(false)
        setName('')
        setRole('MANAGER')
        setLinkTelegram(defaultLinkTelegramFor('MANAGER'))
        setShowCreate(false)
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  function handleRegenerate(userId: string, userName: string) {
    if (!confirm(`Сгенерировать новый PIN для «${userName}»? Старый перестанет работать.`)) return
    startTransition(async () => {
      const r = await regenerateUserPin(userId)
      if (r.ok) {
        setShownCreds({
          title: `Новый PIN: ${userName}`,
          pin: r.data.pin,
          loginUrl: null,
          deepLink: null,
          messageTemplate: `Новый PIN для входа в CRM «Будни»: ${r.data.pin}`,
        })
        setShowDetails(false)
      } else {
        toast.error(r.error)
      }
    })
  }

  function handleToggleActive(u: UserRow) {
    const verb = u.isActive ? 'Отключить' : 'Включить'
    if (!confirm(`${verb} пользователя «${u.name}»?`)) return
    startTransition(async () => {
      const r = await setUserActive(u.id, !u.isActive)
      if (r.ok) {
        toast.success(u.isActive ? `${u.name} отключён` : `${u.name} включён`)
      } else {
        toast.error(r.error)
      }
    })
  }

  function doReissue(u: UserRow) {
    startTransition(async () => {
      const r = await generateOnboardingTokenForUser(u.id)
      if (r.ok) {
        setShownCreds({
          title: `Новая ссылка для Telegram: ${r.data.name}`,
          pin: null,
          loginUrl: r.data.loginUrl,
          deepLink: r.data.deepLink,
          messageTemplate: r.data.messageTemplate,
        })
        setShowDetails(false)
        setReissueTarget(null)
        router.refresh()
      } else {
        toast.error(r.error)
        setReissueTarget(null)
      }
    })
  }

  function doUnlink(u: UserRow) {
    startTransition(async () => {
      const r = await unlinkTelegramFromUser(u.id)
      if (r.ok) {
        toast.success(`Telegram отвязан у «${u.name}»`)
        setReissueTarget(null)
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  function handleTelegramClick(u: UserRow) {
    if (!u.telegramChatId) {
      doReissue(u)
    } else {
      setReissueTarget(u)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          Создание учётных записей и регенерация PIN-кодов
        </p>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          disabled={isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          Добавить пользователя
        </button>
      </div>

      <div
        className="rounded-2xl bg-surface border border-border overflow-hidden"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg/50 text-xs uppercase tracking-wider text-fg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Имя</th>
                <th className="text-left px-3 py-3 font-medium">Роль</th>
                <th className="text-left px-3 py-3 font-medium">Telegram</th>
                <th className="text-left px-3 py-3 font-medium hidden md:table-cell">Создан</th>
                <th className="text-right px-4 py-3 font-medium">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((u) => (
                <tr key={u.id} className={cn('hover:bg-bg/30', !u.isActive && 'opacity-50')}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.name}</div>
                    {!u.isActive && (
                      <div className="text-xs text-danger-fg">отключён</div>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-medium',
                        ROLE_COLORS[u.role]
                      )}
                    >
                      {ROLE_LABELS[u.role]}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-xs text-fg-muted">
                    {u.telegramChatId ? (
                      <span className="inline-flex items-center gap-1 text-success-fg">
                        <Send className="w-3 h-3" />
                        {u.telegramUsername ? `@${u.telegramUsername}` : 'привязан'}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs text-fg-muted hidden md:table-cell">
                    {formatDateMsk(u.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleTelegramClick(u)}
                        disabled={isPending || !u.isActive}
                        title={
                          u.telegramChatId
                            ? 'Перевыдать доступ Telegram'
                            : 'Сгенерировать ссылку для Telegram-бота'
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-pill bg-bg hover:bg-border text-xs disabled:opacity-50"
                      >
                        <Link2 className="w-3.5 h-3.5" />
                        Telegram
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRegenerate(u.id, u.name)}
                        disabled={isPending || !u.isActive}
                        title="Сгенерировать новый PIN"
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-pill bg-bg hover:bg-border text-xs disabled:opacity-50"
                      >
                        <KeyRound className="w-3.5 h-3.5" />
                        Новый PIN
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleActive(u)}
                        disabled={isPending || u.id === currentUserId}
                        title={
                          u.id === currentUserId
                            ? 'Нельзя отключить себя'
                            : u.isActive
                              ? 'Отключить'
                              : 'Включить'
                        }
                        className={cn(
                          'inline-flex items-center px-2.5 py-1 rounded-pill text-xs disabled:opacity-50',
                          u.isActive
                            ? 'bg-bg hover:bg-danger-bg/40 hover:text-danger-fg'
                            : 'bg-success-bg/40 text-success-fg hover:bg-success-bg'
                        )}
                      >
                        {u.isActive ? (
                          <PowerOff className="w-3.5 h-3.5" />
                        ) : (
                          <Power className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setShowCreate(false)}
        >
          <div
            className="bg-surface rounded-2xl border border-border max-w-md w-full p-5 space-y-4"
            style={{ boxShadow: 'var(--shadow-popover)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Новый пользователь</h2>

            <div>
              <label className="block text-xs uppercase tracking-wider text-fg-muted mb-1">
                Имя
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Иван Иванов"
                autoFocus
                disabled={isPending}
                className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent text-sm"
              />
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-fg-muted mb-1">
                Роль
              </label>
              <Select value={role} onValueChange={(v) => handleRoleChange(v as UserRole)} disabled={isPending}>
                <SelectTrigger className="w-full !h-auto px-3 py-2 rounded-xl bg-bg border-border focus-visible:border-accent focus-visible:ring-0 transition-colors text-sm data-placeholder:text-fg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MANAGER">{ROLE_LABELS.MANAGER}</SelectItem>
                  <SelectItem value="ADMIN">{ROLE_LABELS.ADMIN}</SelectItem>
                  <SelectItem value="CHEF">{ROLE_LABELS.CHEF}</SelectItem>
                  <SelectItem value="COURIER">{ROLE_LABELS.COURIER}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <Checkbox
                checked={linkTelegram}
                onCheckedChange={(c) => setLinkTelegram(c === true)}
                disabled={isPending}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <div className="text-sm">Привязать к Telegram-боту</div>
                <div className="text-xs text-fg-muted">
                  Пользователь получит ссылку для бота вместе с PIN. Без этого
                  уведомления приходить не будут.
                </div>
              </div>
            </label>

            <p className="text-xs text-fg-muted">
              PIN будет сгенерирован автоматически (4 цифры) и показан один раз после создания.
            </p>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                disabled={isPending}
                className="px-4 py-2 rounded-pill text-fg-muted text-sm hover:text-fg disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={isPending}
                className="px-4 py-2 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {isPending ? 'Создаём…' : 'Создать'}
              </button>
            </div>
          </div>
        </div>
      )}

      {shownCreds && (
        // НИКАКОГО onClick на overlay — закрытие только по кнопке «Готово»,
        // потому что PIN после закрытия восстановить нельзя.
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div
            className="bg-surface rounded-2xl border border-border max-w-lg w-full p-6 space-y-4"
            style={{ boxShadow: 'var(--shadow-popover)' }}
          >
            <div className="text-center space-y-1">
              <CheckCircle2 className="w-10 h-10 mx-auto text-success-fg" />
              <h2 className="text-lg font-semibold">{shownCreds.title}</h2>
            </div>

            <div className="space-y-2">
              <label className="block text-xs uppercase tracking-wider text-fg-muted">
                Готовый текст для отправки
              </label>
              <textarea
                readOnly
                value={shownCreds.messageTemplate}
                rows={Math.min(
                  10,
                  Math.max(6, shownCreds.messageTemplate.split('\n').length + 1)
                )}
                className="w-full px-3 py-2 rounded-xl bg-bg border border-border text-xs font-mono resize-none focus:outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => copy(shownCreds.messageTemplate, 'Текст скопирован')}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90"
              >
                <Copy className="w-3.5 h-3.5" />
                Скопировать текст
              </button>
            </div>

            <details
              open={showDetails}
              onToggle={(e) =>
                setShowDetails((e.target as HTMLDetailsElement).open)
              }
              className="text-sm"
            >
              <summary className="cursor-pointer text-xs text-fg-muted hover:text-fg select-none">
                По отдельности
              </summary>
              <div className="mt-3 space-y-2 pl-1">
                {shownCreds.pin && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-fg-muted shrink-0 w-16">PIN:</span>
                    <code className="flex-1 font-mono tabular-nums text-base">
                      {shownCreds.pin}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(shownCreds.pin!, 'PIN скопирован')}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-bg hover:bg-border text-xs"
                    >
                      <Copy className="w-3 h-3" />
                      Копировать
                    </button>
                  </div>
                )}
                {shownCreds.loginUrl && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-fg-muted shrink-0 w-16">Вход:</span>
                    <code
                      className="flex-1 font-mono text-xs truncate"
                      title={shownCreds.loginUrl}
                    >
                      {shownCreds.loginUrl}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(shownCreds.loginUrl!, 'Ссылка скопирована')}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-bg hover:bg-border text-xs"
                    >
                      <Copy className="w-3 h-3" />
                      Копировать
                    </button>
                  </div>
                )}
                {shownCreds.deepLink && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-fg-muted shrink-0 w-16">Бот:</span>
                    <code
                      className="flex-1 font-mono text-xs truncate"
                      title={shownCreds.deepLink}
                    >
                      {shownCreds.deepLink}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(shownCreds.deepLink!, 'Deep-link скопирован')}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-bg hover:bg-border text-xs"
                    >
                      <Copy className="w-3 h-3" />
                      Копировать
                    </button>
                  </div>
                )}
              </div>
            </details>

            {shownCreds.pin && (
              <p className="text-xs text-warning-fg bg-warning-bg/30 rounded-xl p-3">
                ⚠️ PIN больше не будет показан — только полная регенерация.
              </p>
            )}
            {shownCreds.deepLink && !shownCreds.pin && (
              <p className="text-xs text-info-fg bg-info-bg/30 rounded-xl p-3">
                Ссылка для бота действует 30 минут.
              </p>
            )}

            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => setShownCreds(null)}
                className="px-5 py-2 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90"
              >
                Готово
              </button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog
        open={!!reissueTarget}
        onOpenChange={(o) => {
          if (!o) setReissueTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {reissueTarget?.name ?? ''} уже привязан к Telegram
            </AlertDialogTitle>
            <AlertDialogDescription>
              У этого пользователя уже работает Telegram-бот
              {' '}
              {reissueTarget?.telegramUsername
                ? `(@${reissueTarget.telegramUsername})`
                : '(без username)'}
              . Перевыдача создаст новую ссылку — старая привязка перестанет
              получать уведомления только после того, как пользователь нажмёт
              новую ссылку. Если хотите сначала отвязать существующий аккаунт —
              нажмите «Отвязать».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isPending}
              onClick={(e) => {
                e.preventDefault()
                if (reissueTarget) doUnlink(reissueTarget)
              }}
            >
              Отвязать
            </AlertDialogAction>
            <AlertDialogAction
              disabled={isPending}
              onClick={(e) => {
                e.preventDefault()
                if (reissueTarget) doReissue(reissueTarget)
              }}
            >
              Перевыдать
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
