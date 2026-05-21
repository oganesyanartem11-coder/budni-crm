import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import type { OrderStatus } from '@prisma/client'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { pluralize } from '@/lib/utils/format'
import { getGreeting } from '@/lib/utils/greeting'
import { getAdminDashboardData } from '@/lib/db/queries/dashboard-stats'
import { countPendingConfirmationToday } from '@/lib/db/queries/orders'
import { ACTIVE_ORDER_STATUSES } from '@/lib/constants/order'
import { getPresetRange, type ReportPreset } from '@/lib/utils/week'
import { AdminWeekBlock } from './admin-week-block'

// Подмножество пресетов, доступных в переключателе дашборда. WoW-бокс
// активен только для week-периодов — для остальных скрываем индикатор.
const DASHBOARD_PRESETS: ReportPreset[] = [
  'this_week', 'last_week', 'this_month', 'this_year', 'custom',
]
const WOW_PRESETS: ReportPreset[] = ['this_week', 'last_week']

// Все «реальные» заказы дня: в работе + уже доставленные. Исключает DRAFT
// (черновики менеджера) и CANCELLED (клиент отменил) — они не должны попадать
// в «сколько у нас сегодня/завтра заказов».
const REAL_ORDER_STATUSES: OrderStatus[] = [...ACTIVE_ORDER_STATUSES, 'DELIVERED']

// force-dynamic: приветствие зависит от текущего часа.
export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  // CHEF не имеет дашборд-содержимого (только ADMIN+MANAGER блоки) — отправляем на свой home.
  if (user.role === 'CHEF') {
    redirect('/production')
  }

  const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d })()
  const todayEnd = (() => { const d = new Date(); d.setHours(23,59,59,999); return d })()
  const tomorrowStart = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0,0,0,0); return d })()
  const tomorrowEnd = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(23,59,59,999); return d })()
  const todayIso = todayStart.toISOString().slice(0, 10)
  const tomorrowIso = tomorrowStart.toISOString().slice(0, 10)

  const [todayAgg, tomorrowAgg, pendingOrders] = await Promise.all([
    prisma.order.aggregate({
      where: { deliveryDate: { gte: todayStart, lt: todayEnd }, status: { in: REAL_ORDER_STATUSES } },
      _count: { id: true },
      _sum: { portions: true },
    }),
    prisma.order.aggregate({
      where: { deliveryDate: { gte: tomorrowStart, lt: tomorrowEnd }, status: { in: REAL_ORDER_STATUSES } },
      _count: { id: true },
      _sum: { portions: true },
    }),
    // Фильтр согласован с listPendingConfirmation: тот же [today, tomorrowEnd],
    // иначе счётчик и список расходятся (счётчик > список → клик → пусто).
    countPendingConfirmationToday(),
  ])

  const todayCount = todayAgg._count.id
  const todayPortions = todayAgg._sum.portions ?? 0
  const tomorrowCount = tomorrowAgg._count.id
  const tomorrowPortions = tomorrowAgg._sum.portions ?? 0

  const isAdminOrManager = user.role === 'ADMIN' || user.role === 'MANAGER'

  // Финансовый блок: пресет из URL, дефолт this_week. Невалидный preset →
  // тоже this_week (без падения).
  const params = await searchParams
  const presetParam = (params.period ?? 'this_week') as ReportPreset
  const preset: ReportPreset = DASHBOARD_PRESETS.includes(presetParam) ? presetParam : 'this_week'
  const range = getPresetRange(preset, params.from, params.to)
  const withWoW = WOW_PRESETS.includes(preset)

  const adminData = isAdminOrManager
    ? await getAdminDashboardData(range.from, range.to, { withWoW })
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <StatCard
                href={`/orders?date=${todayIso}`}
                label="На сегодня"
                value={todayCount}
                hint={
                  todayCount === 0
                    ? 'Заказов на сегодня нет'
                    : `${pluralize(todayPortions, ['порция', 'порции', 'порций'])}`
                }
                tone={todayCount > 0 ? 'info' : 'neutral'}
              />
              <StatCard
                href={`/orders?date=${tomorrowIso}`}
                label="На завтра"
                value={tomorrowCount}
                hint={
                  tomorrowCount === 0
                    ? 'Заказов на завтра пока нет'
                    : `${pluralize(tomorrowPortions, ['порция', 'порции', 'порций'])}`
                }
                tone={tomorrowCount > 0 ? 'info' : 'neutral'}
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
          <AdminWeekBlock
            data={adminData}
            preset={preset}
            periodLabel={range.label}
            customFromIso={params.from}
            customToIso={params.to}
          />
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

