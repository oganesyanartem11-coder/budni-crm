import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { requireRole } from '@/lib/auth/current-user'
import { getProductionSummary } from '@/lib/db/queries/production'
import { formatDateLong } from '@/lib/utils/format'
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
  const targetDate = params.date ? new Date(params.date) : (() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d
  })()
  targetDate.setHours(0, 0, 0, 0)

  const summary = await getProductionSummary(targetDate)
  const dateStr = params.date ?? targetDate.toISOString().slice(0, 10)

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
                    {MEAL_TYPE_LABELS[mt]} · {data.totalPortions} порций
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
            Сформировано: {new Date().toLocaleString('ru-RU')} · Будни CRM
          </div>
        </div>
      </div>
    </>
  )
}
