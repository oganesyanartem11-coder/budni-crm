import { prisma } from '@/lib/db/prisma'
import { REVENUE_STATUSES } from '@/lib/constants/order'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MSK_OFFSET_MS = 3 * 3600 * 1000

export interface ClientComparisonRow {
  clientId: string
  clientName: string
  revenue: number
  ordersCount: number
  portions: number
  prevRevenue: number // 0 если клиент новый
  isNew: boolean // не было заказов в prev-периоде
  growthPct: number | null // null если isNew или prev=0
}

export interface ClientsComparisonResult {
  rows: ClientComparisonRow[] // отсортированы DESC по revenue
}

/**
 * Сравнивает клиентов текущего периода с эквивалентным предыдущим периодом.
 * - Текущий период:  [from, to]
 * - Предыдущий период: [from - periodMs, to - periodMs]
 *
 * Длина периода = totalDays в MSK-семантике (round к MSK-полуночам).
 * Только клиенты с заказами в ТЕКУЩЕМ периоде. Если у клиента не было
 * заказов в prev — isNew=true, growthPct=null.
 */
export async function getClientsComparison(
  from: Date,
  to: Date
): Promise<ClientsComparisonResult> {
  // MSK-нормализация границ для расчёта длины периода (как в material-cost.ts).
  const fromMsk = new Date(from.getTime() + MSK_OFFSET_MS)
  const startMs =
    Date.UTC(
      fromMsk.getUTCFullYear(),
      fromMsk.getUTCMonth(),
      fromMsk.getUTCDate(),
      0, 0, 0, 0
    ) - MSK_OFFSET_MS
  const toMsk = new Date(to.getTime() + MSK_OFFSET_MS)
  const endMs =
    Date.UTC(
      toMsk.getUTCFullYear(),
      toMsk.getUTCMonth(),
      toMsk.getUTCDate(),
      0, 0, 0, 0
    ) - MSK_OFFSET_MS

  if (endMs < startMs) {
    return { rows: [] }
  }

  const totalDays = Math.round((endMs - startMs) / ONE_DAY_MS) + 1
  const periodMs = totalDays * ONE_DAY_MS

  const prevFrom = new Date(from.getTime() - periodMs)
  const prevTo = new Date(to.getTime() - periodMs)

  const [currOrders, prevOrders] = await Promise.all([
    prisma.order.findMany({
      where: {
        deliveryDate: { gte: from, lte: to },
        status: { in: REVENUE_STATUSES },
      },
      select: {
        clientId: true,
        totalPrice: true,
        portions: true,
        client: { select: { name: true } },
      },
    }),
    prisma.order.findMany({
      where: {
        deliveryDate: { gte: prevFrom, lte: prevTo },
        status: { in: REVENUE_STATUSES },
      },
      select: {
        clientId: true,
        totalPrice: true,
      },
    }),
  ])

  const currMap = new Map<
    string,
    { name: string; revenue: number; ordersCount: number; portions: number }
  >()
  for (const o of currOrders) {
    const price = Number(o.totalPrice)
    const existing = currMap.get(o.clientId)
    if (existing) {
      existing.revenue += price
      existing.ordersCount += 1
      existing.portions += o.portions
    } else {
      currMap.set(o.clientId, {
        name: o.client.name,
        revenue: price,
        ordersCount: 1,
        portions: o.portions,
      })
    }
  }

  const prevMap = new Map<string, number>()
  for (const o of prevOrders) {
    const price = Number(o.totalPrice)
    prevMap.set(o.clientId, (prevMap.get(o.clientId) ?? 0) + price)
  }

  const rows: ClientComparisonRow[] = []
  for (const [clientId, curr] of currMap) {
    const prevRevenue = prevMap.get(clientId) ?? 0
    const isNew = !prevMap.has(clientId)
    const growthPct =
      isNew || prevRevenue === 0
        ? null
        : Math.round(((curr.revenue - prevRevenue) / prevRevenue) * 100)

    rows.push({
      clientId,
      clientName: curr.name,
      revenue: curr.revenue,
      ordersCount: curr.ordersCount,
      portions: curr.portions,
      prevRevenue,
      isNew,
      growthPct,
    })
  }

  rows.sort((a, b) => b.revenue - a.revenue)
  return { rows }
}
