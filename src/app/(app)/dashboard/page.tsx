import { redirect } from 'next/navigation'
import { getCurrentUser, requireRole } from '@/lib/auth/current-user'
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

// Пресеты финансового блока дашборда. 7.46: сегменты — rolling-окна
// week_to_date/month_rolling/last_3_months (+ today/yesterday). Календарные
// ключи и custom (Bug 7.24-4 date-range picker) приходят из ?period= и тоже
// считаются через getPresetRange.
type FinancePreset =
  | 'today'
  | 'yesterday'
  | 'week_to_date'
  | 'month_rolling'
  | 'last_3_months'
  | 'this_week'
  | 'this_month'
  | 'this_quarter'
  | 'last_week'
  | 'last_month'
  | 'last_quarter'
  | 'this_year'
  | 'custom'
const FINANCE_PRESETS: FinancePreset[] = [
  'today',
  'yesterday',
  // 7.46: дашбордные rolling-окна (сегменты Нед/Мес/3 мес).
  'week_to_date',
  'month_rolling',
  'last_3_months',
  // Календарные ключи остаются валидными (бэкенд getPresetRange, старые
  // ссылки/picker), но в сегментах дашборда больше не показываются.
  'this_week',
  'this_month',
  'this_quarter',
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
 * 7.46: дашбордные сегменты — rolling-окна week_to_date / month_rolling /
 * last_3_months. Все пресеты (включая старые календарные и rolling) считает
 * getPresetRange. Квартал из дашборда убран — отдельная ручная ветка больше
 * не нужна (если ?period=this_quarter придёт из старой ссылки, getPresetRange
 * вернёт календарный квартал).
 */
function resolveFinanceRange(
  preset: FinancePreset,
  customFrom?: string,
  customTo?: string,
): { from: Date; to: Date } {
  if (preset === 'custom') {
    // Невалидный/неполный custom → безопасный фолбэк на сегодня (дефолт 7.45+).
    const fromOk = customFrom && !Number.isNaN(new Date(customFrom).getTime())
    const toOk = customTo && !Number.isNaN(new Date(customTo).getTime())
    if (!fromOk || !toOk) {
      const range = getPresetRange('today')
      return { from: range.from, to: range.to }
    }
    const range = getPresetRange('custom', customFrom, customTo)
    return { from: range.from, to: range.to }
  }
  const range = getPresetRange(preset)
  return { from: range.from, to: range.to }
}

export default async function DashboardPage({ searchParams }: PageProps) {
  // П7: explicit per-role guards BEFORE requireRole so COURIER/CHEF never reach
  // the failing requireRole (which would, for COURIER, have produced the old
  // /dashboard self-loop).
  const user = await getCurrentUser()
  if (user.role === 'COURIER') {
    redirect('/delivery')
  }
  if (user.role === 'CHEF') {
    redirect('/production')
  }
  // ADMIN_PRO is virtually included by requireRole when 'ADMIN' is present.
  await requireRole(['ADMIN', 'MANAGER'])

  const isAdminLikeUser = isAdminLike(user.role)
  // MANAGER тоже видит выручку (маржу/себестоимость — нет, это решает FinanceWeekBlock).
  const canSeeFinance = isAdminLikeUser || user.role === 'MANAGER'

  // 7.45: Финансовый пресет из URL, дефолт today. Невалидный → today.
  // 7.46: withWoW только на week_to_date — по умолчанию (today) WoW-блок скрыт.
  const params = await searchParams
  const periodParam = (params.period ?? 'today') as FinancePreset
  const preset: FinancePreset = FINANCE_PRESETS.includes(periodParam) ? periodParam : 'today'
  const { from, to } = resolveFinanceRange(preset, params.from, params.to)
  const withWoW = preset === 'week_to_date'

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
