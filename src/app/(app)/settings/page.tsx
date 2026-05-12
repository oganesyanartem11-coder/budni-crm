import Link from 'next/link'
import { Users as UsersIcon, Send, ChevronRight } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { getCurrentUser } from '@/lib/auth/current-user'

export default async function SettingsPage() {
  const user = await getCurrentUser()

  const isAdminOrManager = user.role === 'ADMIN' || user.role === 'MANAGER'

  return (
    <>
      <PageHeader title="Настройки" subtitle={user.name} />

      <div className="space-y-5">
        {isAdminOrManager && (
          <Link
            href="/settings/telegram"
            className="block rounded-2xl bg-surface border border-border p-5 hover:border-border-strong transition-all"
            style={{ boxShadow: 'var(--shadow-card)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-bg flex items-center justify-center">
                  <Send className="w-5 h-5 text-fg-muted" strokeWidth={1.75} />
                </div>
                <div>
                  <h3 className="font-semibold text-base">Telegram</h3>
                  <p className="text-sm text-fg-muted">Привязка аккаунта для уведомлений и сводок</p>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-fg-subtle" />
            </div>
          </Link>
        )}

        {user.role === 'ADMIN' && (
          <Link
            href="/settings/users"
            className="block rounded-2xl bg-surface border border-border p-5 hover:border-border-strong transition-all"
            style={{ boxShadow: 'var(--shadow-card)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-bg flex items-center justify-center">
                  <UsersIcon className="w-5 h-5 text-fg-muted" strokeWidth={1.75} />
                </div>
                <div>
                  <h3 className="font-semibold text-base">Пользователи</h3>
                  <p className="text-sm text-fg-muted">Создание и управление учётками сотрудников</p>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-fg-subtle" />
            </div>
          </Link>
        )}
      </div>
    </>
  )
}
