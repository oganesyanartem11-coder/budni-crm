import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { getLegalEntity } from '../../actions'
import { LegalEntityForm } from '../../legal-entity-form'
import { serialize } from '@/lib/utils/serialize'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function EditLegalEntityPage({ params }: PageProps) {
  await requireRole(['ADMIN'])

  const { id } = await params
  const entity = await getLegalEntity(id)
  if (!entity) notFound()

  return (
    <>
      <PageHeader
        title={entity.shortName}
        subtitle="Редактирование реквизитов"
      />
      <LegalEntityForm mode="edit" initialData={serialize(entity)} />
    </>
  )
}
