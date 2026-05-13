import Link from 'next/link'
import { ChefHat, ArrowRight, type LucideIcon } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { pluralize } from '@/lib/utils/format'
import { getAdminDashboardData } from '@/lib/db/queries/dashboard-stats'
import { AdminWeekBlock } from './admin-week-block'

export default async function DashboardPage() {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  const [todayOrders, pendingOrders] = await Promise.all([
    prisma.order.count({
      where: {
        deliveryDate: {
          gte: (() => { const d = new Date(); d.setHours(0,0,0,0); return d })(),
          lt: (() => { const d = new Date(); d.setHours(23,59,59,999); return d })(),
        },
      },
    }),
    // pending только за сегодня + завтра (cut-off релевантен только для ближайших)
    prisma.order.count({
      where: {
        status: 'PENDING_CONFIRMATION',
        deliveryDate: {
          lte: (() => { const d = new Date(); d.setDate(d.getDate() + 2); d.setHours(23,59,59,999); return d })(),
        },
      },
    }),
  ])

  const isAdminOrManager = user.role === 'ADMIN' || user.role === 'MANAGER'

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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <StatCard
                href="/orders"
                label="На сегодня"
                value={todayOrders}
                hint={todayOrders === 0 ? 'Заказов на сегодня нет' : `${pluralize(todayOrders, ['заказ', 'заказа', 'заказов'])} с доставкой сегодня`}
                tone={todayOrders > 0 ? 'info' : 'neutral'}
              />
              {pendingOrders > 0 ? (
                <Link
                  href="/orders/confirm"
                  className="block rounded-2xl border p-5 transition-all bg-warning-bg/40 border-warning/30 hover:shadow-md cursor-pointer"
                  style={{ boxShadow: 'var(--shadow-card)' }}
                >
                  <p className="text-sm text-fg-muted mb-2">Ждут подтверждения</p>
                  <p className="text-3xl font-bold tracking-tight tabular-nums text-warning-fg">{pendingOrders}</p>
                  <p className="text-xs mt-1 font-semibold text-[#1A1A1A] inline-flex items-center gap-1">
                    Подтвердить до 16:00
                    <ArrowRight className="w-4 h-4" strokeWidth={2} />
                  </p>
                </Link>
              ) : (
                <div
                  className="block rounded-2xl border p-5 bg-surface border-border"
                  style={{ boxShadow: 'var(--shadow-card)' }}
                >
                  <p className="text-sm text-fg-muted mb-2">Ждут подтверждения</p>
                  <p className="text-3xl font-bold tracking-tight tabular-nums">{pendingOrders}</p>
                  <p className="text-xs mt-1 text-fg-subtle">Все на сегодня подтверждены</p>
                </div>
              )}
            </div>
          </section>
        )}

        {isAdminOrManager && adminData && (
          <AdminWeekBlock data={adminData} />
        )}

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
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  href: string
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
      className={`block rounded-2xl border p-5 transition-all hover:shadow-md ${toneClasses[tone]}`}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <p className="text-sm text-fg-muted mb-2">{label}</p>
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
