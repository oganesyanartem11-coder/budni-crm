import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { ClientDetail } from './client-detail'
import { MaxUsersBlock } from './max-users-block'
import { OnboardingChecklist } from './onboarding-checklist'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'
import { getClientAnalytics } from '@/lib/db/queries/client-analytics'
import { MAX_BOT_USERNAME } from '@/lib/bot/onboarding'
import { resolveDeliveryContact } from '@/lib/delivery/contact-resolver'

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(['ADMIN', 'MANAGER'])
  const { id } = await params

  // Активные курьеры нужны в модалке точки для режима «Свой курьер».
  const [client, couriers] = await Promise.all([
    prisma.client.findUnique({
      where: { id },
      include: {
        // Общая секция контактов клиента не должна показывать технические
        // location-scoped контакты доставки.
        contacts: {
          where: { locationId: null },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
        locations: {
          orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
          include: {
            // Загружаем все контакты точки: resolver сам выбирает primary, а
            // затем стабильный location fallback.
            deliveryContacts: {
              orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
              select: {
                id: true,
                clientId: true,
                locationId: true,
                isPrimaryForDelivery: true,
                name: true,
                phone: true,
                notes: true,
                sortOrder: true,
                createdAt: true,
              },
            },
          },
        },
        mealConfigs: {
          orderBy: [{ isActive: 'desc' }, { mealType: 'asc' }],
          include: {
            location: { select: { id: true, name: true } },
          },
        },
        defaultOurLegalEntity: {
          select: { id: true, shortName: true, entityType: true },
        },
        // 7.56: multi-user MAX — привязки + ожидающие захода инвайты.
        maxUsers: {
          orderBy: [{ isActive: 'desc' }, { lastSeenAt: { sort: 'desc', nulls: 'last' } }],
          select: {
            id: true,
            chatId: true,
            username: true,
            isActive: true,
            lastSeenAt: true,
            linkedAt: true,
          },
        },
        maxInvites: {
          where: { usedAt: null, expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            phone: true,
            label: true,
            token: true,
            expiresAt: true,
            createdAt: true,
          },
        },
        _count: {
          select: { orders: true },
        },
      },
    }),
    prisma.user.findMany({
      where: { role: 'COURIER', isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  if (!client) notFound()

  const analytics = await getClientAnalytics(client.id)
  const deliveryContactsByLocationId = Object.fromEntries(
    client.locations.map((location) => [
      location.id,
      resolveDeliveryContact({
        clientId: client.id,
        locationId: location.id,
        contacts: [...location.deliveryContacts, ...client.contacts],
        legacy: { name: client.contactName, phone: client.contactPhone },
      }),
    ]),
  )

  return (
    <>
      <div className="mb-6">
        <Link
          href="/clients"
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-surface border border-border text-sm font-medium text-fg-muted hover:text-fg hover:bg-surface-2 transition-colors min-h-[44px] [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring-orange)]"
        >
          <ArrowLeft className="w-4 h-4" />
          Все клиенты
        </Link>
      </div>
      <OnboardingChecklist client={client} />
      <MaxUsersBlock
        clientId={client.id}
        users={serialize(client.maxUsers)}
        invites={serialize(client.maxInvites)}
        botUsername={MAX_BOT_USERNAME}
      />
      <ClientDetail
        client={serialize(client)}
        analytics={serialize(analytics)}
        couriers={couriers}
        deliveryContactsByLocationId={deliveryContactsByLocationId}
      />
    </>
  )
}
