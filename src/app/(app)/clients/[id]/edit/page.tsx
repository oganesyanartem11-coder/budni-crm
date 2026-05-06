import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/layout/page-header'
import { ClientForm } from '../../client-form'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'

export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(['ADMIN', 'MANAGER'])
  const { id } = await params

  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactPhone: true,
      contactMessenger: true,
      notes: true,
    },
  })

  if (!client) notFound()

  return (
    <>
      <PageHeader
        title={client.name}
        subtitle="Редактирование основных полей"
      />
      <ClientForm client={client} />
    </>
  )
}
