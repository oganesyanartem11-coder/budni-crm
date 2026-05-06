'use client'

import { LogOut } from 'lucide-react'
import { useTransition } from 'react'
import { logoutAction } from '@/app/(auth)/login/actions'
import { cn } from '@/lib/utils/cn'

export function LogoutButton({ className }: { className?: string }) {
  const [isPending, startTransition] = useTransition()

  function handleClick() {
    startTransition(async () => {
      await logoutAction()
    })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      aria-label="Выйти"
      className={cn(
        'w-10 h-10 rounded-full bg-surface-2 hover:bg-danger-bg text-fg-muted hover:text-danger-fg transition-colors flex items-center justify-center disabled:opacity-50',
        className
      )}
    >
      <LogOut className="w-4 h-4" strokeWidth={1.75} />
    </button>
  )
}
