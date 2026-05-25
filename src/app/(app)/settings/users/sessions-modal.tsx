'use client'

import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Loader2, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatDateTimeMsk } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import {
  listUserSessions,
  revokeUserSession,
  type UserSessionView,
} from './actions'

interface Props {
  userId: string | null
  userName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SessionsModal({ userId, userName, open, onOpenChange }: Props) {
  const [sessions, setSessions] = useState<UserSessionView[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [revokingId, setRevokingId] = useState<string | null>(null)

  async function load(uid: string) {
    setLoading(true)
    setError(null)
    const r = await listUserSessions(uid)
    setLoading(false)
    if (r.ok) {
      setSessions(r.data)
    } else {
      setError(r.error)
      setSessions(null)
    }
  }

  useEffect(() => {
    if (open && userId) {
      void load(userId)
    } else if (!open) {
      // Сбрасываем кэш при закрытии — следующее открытие должно подтянуть свежий список
      setSessions(null)
      setError(null)
      setRevokingId(null)
    }
  }, [open, userId])

  function handleRevoke(sessionId: string) {
    if (!userId) return
    setRevokingId(sessionId)
    startTransition(async () => {
      const r = await revokeUserSession(sessionId)
      if (r.ok) {
        toast.success('Сессия отозвана')
        await load(userId)
      } else {
        toast.error(r.error)
      }
      setRevokingId(null)
    })
  }

  function handleRevokeAll() {
    if (!sessions || sessions.length === 0 || !userId) return
    if (!confirm(`Отозвать все ${sessions.length} активных сессий? Юзер вылетит из CRM.`)) return
    startTransition(async () => {
      let failed = 0
      for (const s of sessions) {
        const r = await revokeUserSession(s.id)
        if (!r.ok) failed += 1
      }
      if (failed === 0) toast.success('Все сессии отозваны')
      else toast.error(`Не удалось отозвать ${failed} из ${sessions.length}`)
      await load(userId)
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Активные сессии · {userName}</DialogTitle>
          <DialogDescription>
            Сессии, по которым юзер сейчас залогинен. Отзыв = немедленный выход.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8 text-fg-muted">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        )}

        {error && (
          <div className="rounded-xl bg-danger-bg/40 text-danger-fg p-3 text-xs">
            {error}
          </div>
        )}

        {sessions && !loading && (
          <>
            {sessions.length === 0 ? (
              <p className="text-sm text-fg-muted text-center py-8">
                Нет активных сессий.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-fg-muted">
                    Найдено: {sessions.length}
                  </p>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={isPending}
                    onClick={handleRevokeAll}
                  >
                    Отозвать все
                  </Button>
                </div>
                <div className="max-h-[60vh] overflow-y-auto -mx-4 px-4">
                  <table className="w-full text-xs">
                    <thead className="text-fg-muted uppercase tracking-wider">
                      <tr>
                        <th className="text-left py-2 font-medium">Браузер / ОС</th>
                        <th className="text-left py-2 font-medium hidden sm:table-cell">IP</th>
                        <th className="text-left py-2 font-medium">Активность</th>
                        <th className="text-right py-2 font-medium">·</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {sessions.map((s) => (
                        <tr key={s.id} className="align-top">
                          <td className="py-2 pr-2">
                            <div className="font-medium">
                              {s.browser ?? 'Неизвестный браузер'}
                            </div>
                            <div className="text-fg-muted">
                              {[s.os, s.device].filter(Boolean).join(' · ') || '—'}
                            </div>
                          </td>
                          <td className="py-2 pr-2 font-mono text-fg-muted hidden sm:table-cell">
                            {s.ipAddress ?? '—'}
                          </td>
                          <td className="py-2 pr-2 text-fg-muted">
                            <div>Last: {formatDateTimeMsk(s.lastUsedAt)}</div>
                            <div className="text-[10px]">
                              Created: {formatDateTimeMsk(s.createdAt)}
                            </div>
                            <div className="text-[10px]">
                              Expires: {formatDateTimeMsk(s.expiresAt)}
                            </div>
                          </td>
                          <td className="py-2 text-right">
                            <Button
                              type="button"
                              variant="destructive"
                              size="icon-sm"
                              disabled={isPending}
                              onClick={() => handleRevoke(s.id)}
                              title="Отозвать сессию"
                            >
                              {revokingId === s.id ? (
                                <Loader2 className={cn('w-3.5 h-3.5 animate-spin')} />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
