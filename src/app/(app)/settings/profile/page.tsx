import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { getCurrentUser } from '@/lib/auth/current-user'
import { ROLE_LABELS } from '@/lib/constants/roles'
import { ChangePinForm } from './change-pin-form'

export default async function ProfilePage() {
  // П5: профиль доступен ЛЮБОМУ залогиненному юзеру (без requireRole).
  const me = await getCurrentUser()

  return (
    <>
      <div className="mb-6">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К настройкам
        </Link>
      </div>
      <PageHeader title="Профиль" subtitle={`${me.name} · ${ROLE_LABELS[me.role]}`} />

      <ChangePinForm />
    </>
  )
}
