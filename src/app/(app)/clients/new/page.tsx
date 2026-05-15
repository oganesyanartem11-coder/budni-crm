import { PageHeader } from '@/components/layout/page-header'
import { ClientForm } from '../client-form'
import { requireRole } from '@/lib/auth/current-user'
import { listActiveOurLegalEntitiesForClientForm } from '../actions'

export default async function NewClientPage() {
  await requireRole(['ADMIN', 'MANAGER'])

  const legalEntities = await listActiveOurLegalEntitiesForClientForm()

  return (
    <>
      <PageHeader
        title="Новый клиент"
        subtitle="Заполните основные поля и при желании первую точку"
      />
      <ClientForm isNew legalEntities={legalEntities} />
    </>
  )
}
