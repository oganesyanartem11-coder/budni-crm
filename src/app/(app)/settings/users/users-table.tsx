'use client'

import { useState, useTransition } from 'react'
import { Plus, KeyRound, Power, PowerOff, CheckCircle2, Copy, Send } from 'lucide-react'
import { toast } from 'sonner'
import { createUser, regenerateUserPin, setUserActive } from './actions'
import type { UserRole } from '@prisma/client'
import { cn } from '@/lib/utils/cn'

interface UserRow {
  id: string
  name: string
  role: UserRole
  isActive: boolean
  createdAt: string
  maxChatId: string | null
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

export function UsersTable({ users, currentUserId }: Props) {
  const [isPending, startTransition] = useTransition()
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState<UserRole>('MANAGER')
  const [shownPin, setShownPin] = useState<{ name: string; pin: string } | null>(null)

  function handleCreate() {
    if (!name.trim()) {
      toast.error('Введите имя')
      return
    }
    startTransition(async () => {
      const r = await createUser({ name, role })
      if (r.ok) {
        setShownPin({ name: r.data.name, pin: r.data.pin })
        setName('')
        setRole('MANAGER')
        setShowCreate(false)
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
        setShownPin({ name: userName, pin: r.data.pin })
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

  function copyPin() {
    if (!shownPin) return
    navigator.clipboard.writeText(shownPin.pin)
      .then(() => toast.success('PIN скопирован'))
      .catch(() => toast.error('Не удалось скопировать'))
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

      <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg/50 text-xs uppercase tracking-wider text-fg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Имя</th>
                <th className="text-left px-3 py-3 font-medium">Роль</th>
                <th className="text-left px-3 py-3 font-medium">Telegram</th>
                <th className="text-left px-3 py-3 font-medium">MAX</th>
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
                    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-medium', ROLE_COLORS[u.role])}>
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
                  <td className="px-3 py-3 text-xs text-fg-muted">
                    {u.maxChatId ? '✓ привязан' : '—'}
                  </td>
                  <td className="px-3 py-3 text-xs text-fg-muted hidden md:table-cell">
                    {new Date(u.createdAt).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
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
                        title={u.id === currentUserId ? 'Нельзя отключить себя' : u.isActive ? 'Отключить' : 'Включить'}
                        className={cn(
                          'inline-flex items-center px-2.5 py-1 rounded-pill text-xs disabled:opacity-50',
                          u.isActive ? 'bg-bg hover:bg-danger-bg/40 hover:text-danger-fg' : 'bg-success-bg/40 text-success-fg hover:bg-success-bg'
                        )}
                      >
                        {u.isActive ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
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
              <label className="block text-xs uppercase tracking-wider text-fg-muted mb-1">Имя</label>
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
              <label className="block text-xs uppercase tracking-wider text-fg-muted mb-1">Роль</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                disabled={isPending}
                className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent text-sm"
              >
                <option value="MANAGER">{ROLE_LABELS.MANAGER}</option>
                <option value="ADMIN">{ROLE_LABELS.ADMIN}</option>
                <option value="CHEF">{ROLE_LABELS.CHEF}</option>
                <option value="COURIER">{ROLE_LABELS.COURIER}</option>
              </select>
            </div>

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

      {shownPin && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setShownPin(null)}
        >
          <div
            className="bg-surface rounded-2xl border border-border max-w-md w-full p-6 space-y-4 text-center"
            style={{ boxShadow: 'var(--shadow-popover)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <CheckCircle2 className="w-10 h-10 mx-auto text-success-fg" />
            <h2 className="text-lg font-semibold">PIN для «{shownPin.name}»</h2>
            <div className="text-5xl font-mono font-bold tracking-widest tabular-nums">
              {shownPin.pin}
            </div>
            <p className="text-xs text-warning-fg bg-warning-bg/30 rounded-xl p-3">
              ⚠️ Запишите или сразу передайте сотруднику.
              <br />
              PIN больше не будет показан — только полная регенерация.
            </p>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={copyPin}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-pill border border-border-strong bg-surface text-fg text-sm hover:bg-bg"
              >
                <Copy className="w-3.5 h-3.5" />
                Скопировать
              </button>
              <button
                type="button"
                onClick={() => setShownPin(null)}
                className="px-4 py-2 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90"
              >
                Запомнил
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
