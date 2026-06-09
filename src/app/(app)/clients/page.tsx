import Link from 'next/link'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { ClientsList } from './clients-list'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'

export default async function ClientsPage() {
  await requireRole(['ADMIN', 'MANAGER'])

  const clients = await prisma.client.findMany({
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    include: {
      // isActive нужен для getOnboardingStatus (фильтр ?status=incomplete).
      // where тут тоже на isActive=true — карточки клиента показывают только
      // активные точки/конфиги; поле isActive в select избыточно по факту
      // (все true), но требуется типом ClientForOnboarding.
      locations: {
        where: { isActive: true },
        select: { id: true, name: true, packaging: true, tags: true, isActive: true },
      },
      mealConfigs: {
        where: { isActive: true },
        select: { id: true, mealType: true, orderType: true, fixedPortions: true, pricePerPortion: true, isActive: true },
      },
      // 7.56: «MAX подключён» в onboarding-чек-листе считается по активному ClientMaxUser.
      maxUsers: { select: { isActive: true } },
      _count: {
        select: {
          orders: true,
          locations: { where: { isActive: true } },
          mealConfigs: { where: { isActive: true } },
        },
      },
    },
  })

  return (
    <>
      <PageHeader
        title="Клиенты"
        subtitle="Карточки клиентов, точки, расписания, цены"
        actions={
          <Link
            href="/clients/new"
            style={{ background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }}
            className="px-5 py-2.5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-colors flex items-center gap-2 min-h-[44px] [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            Добавить клиента
          </Link>
        }
      />
      <ClientsList clients={serialize(clients)} />
    </>
  )
}
