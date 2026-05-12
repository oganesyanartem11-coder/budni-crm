import Link from 'next/link'
import { Building2, MapPin, Settings, UtensilsCrossed, Carrot, ClipboardList, ChefHat, type LucideIcon } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { cn } from '@/lib/utils/cn'
import { getAdminDashboardData } from '@/lib/db/queries/dashboard-stats'
import { AdminWeekBlock } from './admin-week-block'

export default async function DashboardPage() {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  // Считаем статистику параллельно
  const [
    activeClients,
    activeLocations,
    activeMealConfigs,
    activeDishes,
    activeIngredients,
    todayOrders,
  ] = await Promise.all([
    prisma.client.count({ where: { isActive: true } }),
    prisma.clientLocation.count({ where: { isActive: true } }),
    prisma.clientMealConfig.count({ where: { isActive: true } }),
    prisma.dish.count({ where: { isActive: true } }),
    prisma.ingredient.count({ where: { isActive: true } }),
    prisma.order.count({
      where: {
        deliveryDate: {
          gte: (() => { const d = new Date(); d.setHours(0,0,0,0); return d })(),
          lt: (() => { const d = new Date(); d.setHours(23,59,59,999); return d })(),
        },
      },
    }),
  ])

  // Считаем pending только за сегодня + завтра (cut-off релевантен только для ближайших)
  const pendingOrders = await prisma.order.count({
    where: {
      status: 'PENDING_CONFIRMATION',
      deliveryDate: {
        lte: (() => { const d = new Date(); d.setDate(d.getDate() + 2); d.setHours(23,59,59,999); return d })(),
      },
    },
  })

  const isAdminOrManager = user.role === 'ADMIN' || user.role === 'MANAGER'
  const isAdminOrChef = user.role === 'ADMIN' || user.role === 'CHEF'

  const adminData = isAdminOrManager
    ? await getAdminDashboardData()
    : null

  return (
    <>
      <PageHeader
        title={`Здравствуйте, ${user.name.split(' ')[0]}`}
        subtitle="Сводка по системе"
      />

      <div className="space-y-6">
        {/* Заказы — самое важное в работе */}
        {isAdminOrManager && (
          <section className="space-y-3">
            <h2 className="text-sm uppercase tracking-wider text-fg-muted font-medium">Заказы</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <StatCard
                href="/orders"
                icon={ClipboardList}
                label="На сегодня"
                value={todayOrders}
                hint="заказов с доставкой сегодня"
                tone={todayOrders > 0 ? 'info' : 'neutral'}
              />
              <Link
                href="/orders/confirm"
                className={cn(
                  'block rounded-2xl border p-5 transition-all hover:border-border-strong',
                  pendingOrders > 0
                    ? 'bg-warning-bg/40 border-warning/30'
                    : 'bg-surface border-border'
                )}
                style={{ boxShadow: 'var(--shadow-card)' }}
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <p className="text-sm text-fg-muted">Ждут подтверждения</p>
                  <ClipboardList className={cn('w-4 h-4', pendingOrders > 0 ? 'text-warning-fg' : 'text-fg-subtle')} strokeWidth={1.75} />
                </div>
                <p className={cn('text-3xl font-bold tracking-tight tabular-nums', pendingOrders > 0 && 'text-warning-fg')}>{pendingOrders}</p>
                <p className="text-xs mt-1 text-fg-subtle">
                  {pendingOrders > 0 ? 'Подтвердить до 16:00 →' : 'Все на сегодня подтверждены'}
                </p>
              </Link>
            </div>
          </section>
        )}

        {isAdminOrManager && adminData && (
          <AdminWeekBlock data={adminData} />
        )}

        {/* Каталоги */}
        <section className="space-y-3">
          <h2 className="text-sm uppercase tracking-wider text-fg-muted font-medium">Каталоги</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {isAdminOrManager && (
              <>
                <StatCard
                  href="/clients"
                  icon={Building2}
                  label="Клиентов"
                  value={activeClients}
                  hint="активных"
                />
                <StatCard
                  href="/clients"
                  icon={MapPin}
                  label="Точек"
                  value={activeLocations}
                  hint="доставки"
                />
                <StatCard
                  href="/clients"
                  icon={Settings}
                  label="Конфигов"
                  value={activeMealConfigs}
                  hint="питания"
                />
              </>
            )}
            <StatCard
              href="/dishes"
              icon={UtensilsCrossed}
              label="Блюд"
              value={activeDishes}
              hint="в справочнике"
            />
            {isAdminOrChef && (
              <StatCard
                href="/ingredients"
                icon={Carrot}
                label="Ингредиентов"
                value={activeIngredients}
                hint="в справочнике"
              />
            )}
          </div>
        </section>

        {/* Заглушки на будущие фичи */}
        <section className="space-y-3">
          <h2 className="text-sm uppercase tracking-wider text-fg-muted font-medium">В разработке</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ComingSoonCard
              label="Производство и сводка по сырью"
              hint="Спринт 3"
              icon={ChefHat}
            />
            <ComingSoonCard
              label="AI-помощник: парсинг заказов из мессенджера"
              hint="Спринт 5"
            />
          </div>
        </section>
      </div>
    </>
  )
}

function StatCard({
  href,
  icon: Icon,
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  href: string
  icon: LucideIcon
  label: string
  value: number
  hint?: string
  tone?: 'neutral' | 'info' | 'warning' | 'success'
}) {
  const toneClasses = {
    neutral: 'bg-surface border-border',
    info: 'bg-info-bg/30 border-info/20',
    warning: 'bg-warning-bg/30 border-warning/20',
    success: 'bg-success-bg/30 border-success/20',
  }

  return (
    <Link
      href={href}
      className={`block rounded-2xl border p-5 transition-all hover:border-border-strong ${toneClasses[tone]}`}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <p className="text-sm text-fg-muted">{label}</p>
        <Icon className="w-4 h-4 text-fg-subtle" strokeWidth={1.75} />
      </div>
      <p className="text-3xl font-bold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="text-xs text-fg-subtle mt-1">{hint}</p>}
    </Link>
  )
}

function ComingSoonCard({
  label,
  hint,
  icon: Icon,
}: {
  label: string
  hint: string
  icon?: LucideIcon
}) {
  return (
    <div
      className="rounded-2xl bg-surface border border-border border-dashed p-5 opacity-70"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <p className="text-sm text-fg-muted">{label}</p>
        {Icon && <Icon className="w-4 h-4 text-fg-subtle" strokeWidth={1.75} />}
      </div>
      <p className="text-xs text-fg-subtle mt-1">Появится в {hint}</p>
    </div>
  )
}
