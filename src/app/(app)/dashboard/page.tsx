import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { pluralize } from '@/lib/utils/format'
import { getGreeting } from '@/lib/utils/greeting'
import { getAdminDashboardData } from '@/lib/db/queries/dashboard-stats'
import { countPendingConfirmationToday } from '@/lib/db/queries/orders'
import { AdminWeekBlock } from './admin-week-block'

// force-dynamic: приветствие зависит от текущего часа.
export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  // CHEF не имеет дашборд-содержимого (только ADMIN+MANAGER блоки) — отправляем на свой home.
  if (user.role === 'CHEF') {
    redirect('/production')
  }

  const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d })()
  const todayEnd = (() => { const d = new Date(); d.setHours(23,59,59,999); return d })()
  const tomorrowStart = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0,0,0,0); return d })()
  const tomorrowEnd = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(23,59,59,999); return d })()

  const [todayOrders, tomorrowOrders, pendingOrders] = await Promise.all([
    prisma.order.count({ where: { deliveryDate: { gte: todayStart, lt: todayEnd } } }),
    prisma.order.count({ where: { deliveryDate: { gte: tomorrowStart, lt: tomorrowEnd } } }),
    // Фильтр согласован с listPendingConfirmation: тот же [today, tomorrowEnd],
    // иначе счётчик и список расходятся (счётчик > список → клик → пусто).
    countPendingConfirmationToday(),
  ])

  // Fallback: если на сегодня заказов нет, но завтра есть — карточка переключается
  // на «На завтра», чтобы менеджер сразу видел работу, а не пустой ноль.
  const showTomorrow = todayOrders === 0 && tomorrowOrders > 0
  const primaryLabel = showTomorrow ? 'На завтра' : 'На сегодня'
  const primaryValue = showTomorrow ? tomorrowOrders : todayOrders
  const primaryHint = showTomorrow
    ? 'Заказов на сегодня нет'
    : todayOrders === 0
      ? 'Заказов на сегодня нет'
      : `${pluralize(todayOrders, ['заказ', 'заказа', 'заказов'])} с доставкой сегодня`

  const isAdminOrManager = user.role === 'ADMIN' || user.role === 'MANAGER'

  const adminData = isAdminOrManager
    ? await getAdminDashboardData()
    : null

  return (
    <>
      <PageHeader
        title={`${getGreeting()}, ${user.name.split(' ')[0]}`}
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
                label={primaryLabel}
                value={primaryValue}
                hint={primaryHint}
                tone={primaryValue > 0 ? 'info' : 'neutral'}
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

