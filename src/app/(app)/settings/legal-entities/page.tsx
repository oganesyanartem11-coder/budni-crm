import Link from 'next/link'
import { ArrowLeft, Plus } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { listLegalEntities } from './actions'
import { LegalEntitiesList } from './legal-entities-list'
import { serialize } from '@/lib/utils/serialize'

export default async function LegalEntitiesPage() {
  await requireRole(['ADMIN'])

  const entities = await listLegalEntities()

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

      <PageHeader
        title="Юридические лица"
        subtitle="Наши ИП и ООО для отгрузки клиентам"
        actions={
          <Link
            href="/settings/legal-entities/new"
            className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Добавить юрлицо
          </Link>
        }
      />

      <LegalEntitiesList entities={serialize(entities)} />
    </>
  )
}
