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
  getMarginForPeriod,
  type AdminDashboardData,
  type PeriodMargin,
} from '@/lib/db/queries/dashboard-stats'
import { GreetingRow } from './_components/greeting-row'
import { HeroTodayTomorrow } from './_components/hero-today-tomorrow'
import { ActionRequiredBlock } from './_components/action-required-block'
import { FinanceWeekBlock } from './_components/finance-week-block'
import { CutOffBlock } from './_components/cutoff-block'

// Пресеты финансового блока дашборда. Сегмент Нед/Мес/Кв = первые три; остальные
// (Bug 7.24-4 date-range picker) + custom приходят из ?period= и считаются через
// getPresetRange. Квартал считается вручную (frozen-контракт), остальное — getPresetRange.
type FinancePreset =
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'this_quarter'
  | 'yesterday'
  | 'last_week'
  | 'last_month'
  | 'last_quarter'
  | 'this_year'
  | 'custom'
const FINANCE_PRESETS: FinancePreset[] = [
  'today',
  'this_week',
  'this_month',
  'this_quarter',
  'yesterday',
  'last_week',
  'last_month',
  'last_quarter',
  'this_year',
  'custom',
]

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
function resolveFinanceRange(
  preset: FinancePreset,
  customFrom?: string,
  customTo?: string,
): { from: Date; to: Date } {
  if (preset === 'this_quarter') {
    const now = new Date()
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3
    const from = new Date(now.getFullYear(), quarterStartMonth, 1, 0, 0, 0, 0)
    const to = new Date(now)
    to.setHours(23, 59, 59, 999)
    return { from, to }
  }
  if (preset === 'custom') {
    // Невалидный/неполный custom → безопасный фолбэк на текущую неделю.
    const fromOk = customFrom && !Number.isNaN(new Date(customFrom).getTime())
    const toOk = customTo && !Number.isNaN(new Date(customTo).getTime())
    if (!fromOk || !toOk) {
      const range = getPresetRange('this_week')
      return { from: range.from, to: range.to }
    }
    const range = getPresetRange('custom', customFrom, customTo)
    return { from: range.from, to: range.to }
  }
  // today / this_week / this_month / yesterday / last_week / last_month / last_quarter / this_year
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
  const { from, to } = resolveFinanceRange(preset, params.from, params.to)
  const withWoW = preset === 'this_week'

  const [today, tomorrow, dailyRecord, financeData, marginData, hasUnreadInbox] =
    await Promise.all([
      getTodayHeroData(),
      getTomorrowHeroData(),
      getRoughDailyRecord(),
      canSeeFinance
        ? getAdminDashboardData(from, to, { withWoW })
        : Promise.resolve<AdminDashboardData | null>(null),
      // Маржа — только для admin-like (карточка маржи в FinanceWeekBlock
      // показывается лишь при isAdminLikeUser; MANAGER не видит себестоимость).
      // ТЕ ЖЕ from/to, что у financeData.
      isAdminLikeUser
        ? getMarginForPeriod(from, to)
        : Promise.resolve<PeriodMargin | null>(null),
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
  // initials для mobile ProfileMenu (Bug 7.25-B) — как в (app)/layout.tsx для sidebar.
  const initials = user.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <>
      <div className="space-y-6">
        <GreetingRow userName={userName} initials={initials} role={user.role} hasUnreadInbox={hasUnreadInbox} />

        <HeroTodayTomorrow today={today} tomorrow={tomorrow} dailyRecord={dailyRecord} />

        <ActionRequiredBlock />

        {/* TODO Волна 6: секция «Клиенты под риском» (отток/давно не заказывали). */}
        {/* TODO Волна 6: спарклайн «Месяц / 12 месяцев» — динамика выручки. */}

        {/* TODO Волна 6: переосмыслить размещение онбординг-секции */}

        {financeData && (
          <FinanceWeekBlock
            data={financeData}
            margin={marginData}
            preset={preset}
            customFrom={params.from}
            customTo={params.to}
            isAdminLikeUser={isAdminLikeUser}
          />
        )}

        {/* Bug 7.24-5: cut-off дня — отдельным блоком ПОД финансами. */}
        <CutOffBlock />
      </div>
    </>
  )
}
