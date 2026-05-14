'use client'

import Link from 'next/link'
import { useTransition } from 'react'
import { Settings as SettingsIcon, LogOut, Users as UsersIcon } from 'lucide-react'
import { logoutAction } from '@/app/(auth)/login/actions'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { ROLE_LABELS } from '@/lib/navigation'
import type { UserRole } from '@prisma/client'

interface Props {
  name: string
  initials: string
  role: UserRole
  variant?: 'desktop' | 'mobile'
}

export function ProfileMenu({ name, initials, role, variant = 'desktop' }: Props) {
  const [isPending, startTransition] = useTransition()

  function handleLogout() {
    startTransition(async () => {
      await logoutAction()
    })
  }

  const Trigger =
    variant === 'desktop' ? (
      <button
        type="button"
        aria-label="Меню профиля"
        className="w-full flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-fg/5 transition-colors text-left"
      >
        <div
          title={name}
          className="w-9 h-9 rounded-full bg-accent text-accent-fg flex items-center justify-center text-xs font-semibold shrink-0"
        >
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-fg truncate leading-tight">{name}</p>
          <p className="text-xs text-fg-subtle truncate leading-tight mt-0.5">{ROLE_LABELS[role]}</p>
        </div>
      </button>
    ) : (
      <button
        type="button"
        aria-label="Меню профиля"
        title={name}
        className="w-9 h-9 rounded-full bg-accent text-accent-fg flex items-center justify-center text-xs font-semibold hover:opacity-90 transition-opacity"
      >
        {initials}
      </button>
    )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{Trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <div className="px-2 py-1.5 text-xs text-fg-muted">
          {name}
          <span className="text-fg-subtle"> · {ROLE_LABELS[role]}</span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="focus:bg-bg focus:text-fg [&_*]:focus:text-fg">
          <Link href="/settings" className="flex items-center gap-2 cursor-pointer text-fg">
            <SettingsIcon className="w-4 h-4" />
            Настройки
          </Link>
        </DropdownMenuItem>
        {role === 'ADMIN' && (
          <DropdownMenuItem asChild className="focus:bg-bg focus:text-fg [&_*]:focus:text-fg">
            <Link href="/settings/users" className="flex items-center gap-2 cursor-pointer text-fg">
              <UsersIcon className="w-4 h-4" />
              Пользователи
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleLogout}
          disabled={isPending}
          className="flex items-center gap-2 text-danger-fg focus:bg-danger-bg/40 focus:text-danger-fg [&_*]:focus:text-danger-fg cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          {isPending ? 'Выходим…' : 'Выйти'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
