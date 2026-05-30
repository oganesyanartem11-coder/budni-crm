import { redirect } from 'next/navigation'
import { requireRole } from '@/lib/auth/current-user'
import { isAdminLike } from '@/lib/auth/role-helpers'
import { prisma } from '@/lib/db/prisma'
import { getPresetRange } from '@/lib/utils/week'
import {
  getTodayHeroData,
  getTomorrowHeroData,
  getRoughDailyRecord,
} from '@/lib/db/queries/dashboard-hero'
import {
  getAdminDashboardData,
  type AdminDashboardData,
} from '@/lib/db/queries/dashboard-stats'
import { GreetingRow } from './_components/greeting-row'
import { HeroTodayTomorrow } from './_components/hero-today-tomorrow'
import { ActionRequiredBlock } from './_components/action-required-block'
import { FinanceWeekBlock } from './_components/finance-week-block'

// Пресеты финансового блока дашборда. Подмножество ReportPreset; квартал
// считается вручную (см. ниже), остальные — через getPresetRange.
type FinancePreset = 'this_week' | 'this_month' | 'this_quarter'
const FINANCE_PRESETS: FinancePreset[] = ['this_week', 'this_month', 'this_quarter']

// force-dynamic: hero/приветствие зависят от текущего момента (сегодня/завтра).
export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>
}

/**
 * Диапазон финансового блока по пресету.
 * this_week / this_month → getPresetRange (Date-границы).
 * this_quarter → считаем вручную: getPresetRange НЕ входит в замороженный
 * контракт по кварталу, поэтому начало календарного квартала + конец сегодня
 * вычисляем тут Date-математикой.
 */
function resolveFinanceRange(preset: FinancePreset): { from: Date; to: Date } {
  if (preset === 'this_quarter') {
    const now = new Date()
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3
    const from = new Date(now.getFullYear(), quarterStartMonth, 1, 0, 0, 0, 0)
    const to = new Date(now)
    to.setHours(23, 59, 59, 999)
    return { from, to }
  }
  const range = getPresetRange(preset)
  return { from: range.from, to: range.to }
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  // CHEF не имеет дашборд-содержимого — отправляем на свой home.
  if (user.role === 'CHEF') {
    redirect('/production')
  }

  const isAdminLikeUser = isAdminLike(user.role)
  // MANAGER тоже видит выручку (маржу/себестоимость — нет, это решает FinanceWeekBlock).
  const canSeeFinance = isAdminLikeUser || user.role === 'MANAGER'

  // Финансовый пресет из URL, дефолт this_week. Невалидный → this_week.
  const params = await searchParams
  const periodParam = (params.period ?? 'this_week') as FinancePreset
  const preset: FinancePreset = FINANCE_PRESETS.includes(periodParam) ? periodParam : 'this_week'
  const { from, to } = resolveFinanceRange(preset)
  const withWoW = preset === 'this_week'

  const [today, tomorrow, dailyRecord, financeData, hasUnreadInbox] = await Promise.all([
    getTodayHeroData(),
    getTomorrowHeroData(),
    getRoughDailyRecord(),
    canSeeFinance
      ? getAdminDashboardData(from, to, { withWoW })
      : Promise.resolve<AdminDashboardData | null>(null),
    // Inbox-индикатор для приветствия. Тот же запрос, что в src/app/(app)/layout.tsx
    // (botMessage.count direction IN + readAt null). Только для admin/manager.
    canSeeFinance
      ? prisma.botMessage
          .count({ where: { direction: 'IN', readAt: null } })
          .then((n) => n > 0)
      : Promise.resolve(false),
  ])

  // userName: первое слово из user.name (firstName в модели нет).
  const userName = user.name.split(' ')[0]

  return (
    <>
      <div className="space-y-6">
        <GreetingRow userName={userName} hasUnreadInbox={hasUnreadInbox} />

        <HeroTodayTomorrow today={today} tomorrow={tomorrow} dailyRecord={dailyRecord} />

        <ActionRequiredBlock />

        {/* TODO Волна 6: секция «Клиенты под риском» (отток/давно не заказывали). */}
        {/* TODO Волна 6: спарклайн «Месяц / 12 месяцев» — динамика выручки. */}

        {/* TODO Волна 6: переосмыслить размещение онбординг-секции */}

        {financeData && (
          <FinanceWeekBlock
            data={financeData}
            preset={preset}
            isAdminLikeUser={isAdminLikeUser}
          />
        )}
      </div>
    </>
  )
}
