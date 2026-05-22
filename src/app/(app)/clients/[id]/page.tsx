import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Edit2, ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { ClientDetail } from './client-detail'
import { MaxChatIdSection } from './max-chat-id-section'
import { OnboardingChecklist } from './onboarding-checklist'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'
import { getClientAnalytics } from '@/lib/db/queries/client-analytics'

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(['ADMIN', 'MANAGER'])
  const { id } = await params

  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      locations: { orderBy: [{ isActive: 'desc' }, { name: 'asc' }] },
      mealConfigs: {
        orderBy: [{ isActive: 'desc' }, { mealType: 'asc' }],
        include: {
          location: { select: { id: true, name: true } },
        },
      },
      defaultOurLegalEntity: {
        select: { id: true, shortName: true, entityType: true },
      },
      _count: {
        select: { orders: true },
      },
    },
  })

  if (!client) notFound()

  const analytics = await getClientAnalytics(client.id)

  return (
    <>
      <div className="mb-6">
        <Link
          href="/clients"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Все клиенты
        </Link>
      </div>
      <PageHeader
        title={client.name}
        subtitle={
          client.contactName
            ? `${client.contactName}${client.contactPhone ? ` · ${client.contactPhone}` : ''}`
            : 'Карточка клиента'
        }
        actions={
          <Link
            href={`/clients/${client.id}/edit`}
            className="px-4 py-2 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors flex items-center gap-2"
          >
            <Edit2 className="w-4 h-4" />
            Редактировать
          </Link>
        }
      />
      <OnboardingChecklist client={client} />
      <MaxChatIdSection
        clientId={client.id}
        currentValue={client.maxChatId}
        onboardingToken={client.maxOnboardingToken}
        onboardedAt={null}
      />
      <ClientDetail client={serialize(client)} analytics={serialize(analytics)} />
    </>
  )
}
