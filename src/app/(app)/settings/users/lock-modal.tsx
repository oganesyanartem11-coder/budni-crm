'use client'

import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { lockUser } from './actions'

interface Props {
  userId: string | null
  userName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onLocked?: () => void
}

const DEFAULT_HOURS = 24
const MIN_HOURS = 1
const MAX_HOURS = 720

export function LockModal({ userId, userName, open, onOpenChange, onLocked }: Props) {
  const [hours, setHours] = useState<number>(DEFAULT_HOURS)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (open) setHours(DEFAULT_HOURS)
  }, [open])

  function handleConfirm() {
    if (!userId) return
    if (!Number.isFinite(hours) || hours < MIN_HOURS || hours > MAX_HOURS) {
      toast.error(`Часы должны быть от ${MIN_HOURS} до ${MAX_HOURS}`)
      return
    }
    startTransition(async () => {
      const r = await lockUser(userId, hours)
      if (r.ok) {
        toast.success(`${userName} заблокирован на ${hours} ч`)
        onOpenChange(false)
        onLocked?.()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Заблокировать · {userName}</DialogTitle>
          <DialogDescription>
            Активные сессии будут отозваны. Юзер не сможет войти до истечения срока.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label
            htmlFor="lock-hours"
            className="block text-xs uppercase tracking-wider text-fg-muted"
          >
            Часов блокировки ({MIN_HOURS}..{MAX_HOURS})
          </label>
          <input
            id="lock-hours"
            type="number"
            min={MIN_HOURS}
            max={MAX_HOURS}
            step={1}
            value={hours}
            onChange={(e) => {
              const v = e.target.valueAsNumber
              setHours(Number.isNaN(v) ? 0 : v)
            }}
            disabled={isPending}
            className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent text-sm font-mono tabular-nums"
          />
          <p className="text-xs text-fg-muted">
            24 ч = сутки, 168 ч = неделя, 720 ч = 30 дней.
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => onOpenChange(false)}
          >
            Отмена
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isPending}
            onClick={handleConfirm}
          >
            {isPending ? 'Блокируем…' : 'Заблокировать'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
