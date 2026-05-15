import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { LegalEntityForm } from '../legal-entity-form'

export default async function NewLegalEntityPage() {
  await requireRole(['ADMIN'])

  return (
    <>
      <PageHeader
        title="Новое юрлицо"
        subtitle="Заполните реквизиты — они попадут в УПД"
      />
      <LegalEntityForm mode="create" />
    </>
  )
}
