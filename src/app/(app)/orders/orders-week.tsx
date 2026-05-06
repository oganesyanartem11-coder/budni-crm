'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { WEEKDAY_NAMES_SHORT, getDateForDayOfWeek } from '@/lib/utils/week'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { cn } from '@/lib/utils/cn'
import type { Order, Client, MealType } from '@prisma/client'

type SerializedWeekOrder = Omit<Order, 'pricePerPortion' | 'totalPrice'> & {
  pricePerPortion: number
  totalPrice: number
  client: Pick<Client, 'id' | 'name'>
}

interface Props {
  orders: SerializedWeekOrder[]
  weekStart: Date
}

interface ClientDayCell {
  byMealType: Map<MealType, number> // суммарные порции по типам
  totalPortions: number
}

export function OrdersWeek({ orders, weekStart }: Props) {
  // Группируем по клиентам и дням
  const data = useMemo(() => {
    const clientsMap = new Map<string, { id: string; name: string }>()
    // ключ: clientId|dayOfWeek (1-7)
    const cells = new Map<string, ClientDayCell>()

    for (const o of orders) {
      clientsMap.set(o.client.id, o.client)

      // Вычисляем dayOfWeek из deliveryDate относительно weekStart
      const orderDate = new Date(o.deliveryDate)
      orderDate.setHours(0, 0, 0, 0)
      const diffDays = Math.round((orderDate.getTime() - weekStart.getTime()) / (1000 * 60 * 60 * 24))
      const dow = diffDays + 1 // 1-based
      if (dow < 1 || dow > 7) continue

      const key = `${o.client.id}|${dow}`
      let cell = cells.get(key)
      if (!cell) {
        cell = { byMealType: new Map(), totalPortions: 0 }
        cells.set(key, cell)
      }
      const prev = cell.byMealType.get(o.mealType) ?? 0
      cell.byMealType.set(o.mealType, prev + o.portions)
      cell.totalPortions += o.portions
    }

    const sortedClients = Array.from(clientsMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'))

    return { clients: sortedClients, cells }
  }, [orders, weekStart])

  if (data.clients.length === 0) {
    return (
      <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
        <p>На этой неделе нет заказов</p>
      </div>
    )
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return (
    <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-bg/50">
              <th className="text-left px-3 py-3 text-xs uppercase tracking-wider text-fg-muted font-medium sticky left-0 bg-bg/50 min-w-[180px]">
                Клиент
              </th>
              {[1, 2, 3, 4, 5, 6, 7].map((dow) => {
                const dayDate = getDateForDayOfWeek(weekStart, dow)
                const isToday = dayDate.getTime() === today.getTime()
                return (
                  <th key={dow} className={cn(
                    'text-left px-3 py-3 text-xs uppercase tracking-wider font-medium min-w-[110px]',
                    isToday ? 'bg-warning-bg/30 text-warning-fg' : 'text-fg-muted'
                  )}>
                    <div>{WEEKDAY_NAMES_SHORT[dow]}</div>
                    <div className="text-fg-subtle font-normal mt-0.5">
                      {dayDate.getDate()}.{(dayDate.getMonth() + 1).toString().padStart(2, '0')}
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.clients.map((client) => (
              <tr key={client.id}>
                <td className="px-3 py-3 align-top sticky left-0 bg-surface">
                  <Link href={`/clients/${client.id}`} className="font-medium hover:underline">
                    {client.name}
                  </Link>
                </td>
                {[1, 2, 3, 4, 5, 6, 7].map((dow) => {
                  const cell = data.cells.get(`${client.id}|${dow}`)
                  const dayDate = getDateForDayOfWeek(weekStart, dow)
                  const isToday = dayDate.getTime() === today.getTime()

                  return (
                    <td key={dow} className={cn(
                      'px-3 py-3 align-top',
                      isToday && 'bg-warning-bg/10'
                    )}>
                      {cell ? (
                        <div className="space-y-0.5">
                          <div className="font-semibold text-base tabular-nums">
                            {cell.totalPortions}
                          </div>
                          <div className="text-xs text-fg-muted space-y-0.5">
                            {Array.from(cell.byMealType.entries()).map(([mt, count]) => (
                              <div key={mt}>
                                {MEAL_TYPE_LABELS[mt][0]}: {count}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="text-fg-subtle text-xs">—</div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-3 text-xs text-fg-subtle border-t border-border">
        З — Завтрак, О — Обед, У — Ужин. Итог сверху — все типы вместе.
      </div>
    </div>
  )
}
