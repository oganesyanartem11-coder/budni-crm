import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/layout/page-header'
import { ClientForm } from '../../client-form'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { listActiveOurLegalEntitiesForClientForm } from '../../actions'
import { serialize } from '@/lib/utils/serialize'

export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(['ADMIN', 'MANAGER'])
  const { id } = await params

  const [client, legalEntities] = await Promise.all([
    prisma.client.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        contactName: true,
        contactPhone: true,
        contactMessenger: true,
        notes: true,
        legalName: true,
        inn: true,
        kpp: true,
        ogrn: true,
        legalAddress: true,
        bankName: true,
        bankBic: true,
        bankAccount: true,
        bankCorrAccount: true,
        contractNumber: true,
        contractDate: true,
        defaultOurLegalEntityId: true,
      },
    }),
    listActiveOurLegalEntitiesForClientForm(),
  ])

  if (!client) notFound()

  return (
    <>
      <PageHeader
        title={client.name}
        subtitle="Редактирование основных полей"
      />
      <ClientForm client={serialize(client)} legalEntities={legalEntities} />
    </>
  )
}
