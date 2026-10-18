import Link from 'next/link'
import { getMskCalendarDayUtc, toMskDateString } from '@/lib/utils/msk-window'
import { ArrowLeft } from 'lucide-react'
import { requireRole } from '@/lib/auth/current-user'
import { getProductionSummary } from '@/lib/db/queries/production'
import { formatDateLong, formatDateTimeMsk, formatPortions } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { DISH_CATEGORY_LABELS } from '@/lib/constants/dish-categories'
import { PrintButton } from '../print-button'
import type { MealType, DishCategory } from '@prisma/client'

const MEAL_TYPE_ORDER: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function KitchenPrintPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'CHEF', 'MANAGER'])

  const params = await searchParams
  // YYYY-MM-DD → UTC-полночь МСК-дня (@db.Date); по умолчанию завтра по МСК.
  const dateStr = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : toMskDateString(getMskCalendarDayUtc(new Date(), 1))
  const targetDate = new Date(`${dateStr}T00:00:00.000Z`)

  const summary = await getProductionSummary(targetDate)

  return (
    <>
      {/* Тулбар — скрывается при печати */}
      <div className="no-print mb-6 flex items-center justify-between gap-3 flex-wrap">
        <Link
          href={`/production/print?date=${dateStr}`}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К меню печати
        </Link>
        <PrintButton />
      </div>

      <div className="print-area max-w-3xl mx-auto bg-surface border border-border rounded-2xl p-8" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="print-page">
          <h1 className="print-title text-2xl font-bold mb-1">Кухонный лист</h1>
          <p className="text-fg-muted text-sm capitalize mb-6">{formatDateLong(targetDate)}</p>

          {summary.totalPortions === 0 ? (
            <p className="text-fg-muted">На эту дату нет активных заказов.</p>
          ) : !summary.hasMenu ? (
            <p className="text-danger-fg font-medium">
              Меню на эту дату не утверждено. Обратитесь к менеджеру.
            </p>
          ) : (
            MEAL_TYPE_ORDER.map((mt) => {
              const data = summary.mealTypes[mt]
              if (data.totalPortions === 0) return null

              return (
                <div key={mt} className="mb-8 last:mb-0">
                  <h2 className="print-section text-xl font-bold mb-2">
                    {MEAL_TYPE_LABELS[mt]} · {formatPortions(data.totalPortions)}
                  </h2>

                  {data.dishes.length === 0 ? (
                    <p className="text-fg-muted text-sm">Меню не задано</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr>
                          <th className="text-left">Категория</th>
                          <th className="text-left">Блюдо</th>
                          <th className="text-right">Порций</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.dishes.map((d) => (
                          <tr key={d.dishId}>
                            <td className="text-fg-muted">{DISH_CATEGORY_LABELS[d.category as DishCategory]}</td>
                            <td className="font-medium">{d.dishName}</td>
                            <td className="text-right tabular-nums font-semibold">{d.totalPortions}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )
            })
          )}

          <div className="mt-8 pt-4 border-t border-border text-xs text-fg-subtle">
            Сформировано: {formatDateTimeMsk(new Date())} · Будни CRM
          </div>
        </div>
      </div>
    </>
  )
}
