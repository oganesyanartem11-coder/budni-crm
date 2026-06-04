/**
 * Tools для AI-агента Action-Бориса (Спринт 7.16.A.2, блок B2).
 *
 * Архитектурный принцип:
 * - READ tools (find_orders, get_*) — реально дёргают БД, возвращают данные модели
 * - MUTATE tools (edit_/cancel_/restore_/create_/reschedule_/add_note_) — НЕ
 *   выполняют действие, а возвращают `{ pending: true, action, preview }`.
 *   Реальное исполнение через executor.ts после подтверждения юзером.
 *
 * Это позволяет нам в одном LLM-turn'е собрать несколько действий, показать
 * preview через `buildMultiActionPreview`, и применить их атомарно после
 * inline-кнопки «Подтверждаю».
 *
 * Все tool.execute оборачиваются agent-loop в try/catch и сериализуют
 * результат в JSON для модели — мы можем спокойно возвращать обычные объекты.
 *
 * Большие списки обрезаем до 20 элементов с `truncated: true` — чтобы не раздувать
 * контекст модели и не ловить max_tokens.
 */

import type { AgentTool } from '@/lib/llm/agent-loop'
import { prisma } from '@/lib/db/prisma'
import { escapeHtml } from '@/lib/telegram/notify'
import type { MealType, Prisma } from '@prisma/client'
import {
  MEAL_TYPE_RU,
  ORDER_STATUS_RU,
  formatDateHuman,
  formatPortions,
} from './labels'
import { resolveClient } from './client-resolver'
import { toMskDateString } from '@/lib/utils/msk-window'

/**
 * Спец-результат tool'а когда резолвер клиента не дал единственного кандидата.
 * Боря по промту обязан переспросить менеджера, а не угадывать.
 */
type ClientResolveFailure = {
  ok: false
  reason: 'no_match' | 'ambiguous'
  candidates: Array<{ id: string; name: string }>
}

/**
 * MEGA-4a-fix: спец-результат для SAME-DAY клиента на будущую дату. Он сам
 * подтвердит заказ утром в день доставки через daily-questions-sameday (~07:40),
 * поэтому Боря НЕ создаёт ему предзаявку руками — объясняет менеджеру.
 */
type SameDayFutureFailure = {
  ok: false
  reason: 'same_day_future' | 'same_day_future_create_blocked'
  clientName: string
  deliveryDate: string
}

const MAX_LIST_ITEMS = 20

/**
 * true если 'YYYY-MM-DD' дата доставки — БУДУЩИЙ МСК-день относительно сейчас
 * (т.е. завтра или позже). Сравнение строк YYYY-MM-DD лексикографически
 * корректно. Используется для блокировки ручных предзаявок same-day клиентам.
 */
function isFutureMskDate(dateStr: string): boolean {
  return dateStr > toMskDateString(new Date())
}

/** Форматирует DateTime → 'YYYY-MM-DD' (UTC, как хранится в @db.Date). */
function formatDate(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d)
  return dt.toISOString().slice(0, 10)
}

function truncate<T>(arr: T[]): { items: T[]; truncated: boolean; total: number } {
  if (arr.length <= MAX_LIST_ITEMS) {
    return { items: arr, truncated: false, total: arr.length }
  }
  return { items: arr.slice(0, MAX_LIST_ITEMS), truncated: true, total: arr.length }
}

// ============================================================
// READ tools
// ============================================================

const findOrdersTool: AgentTool = {
  name: 'find_orders',
  description:
    'Найти заказы по части имени клиента (ILIKE) и опционально по дате и типу приёма пищи. Используй ПЕРЕД любой mutation, чтобы получить orderId и updatedAt.',
  input_schema: {
    type: 'object',
    properties: {
      clientNameQuery: { type: 'string', description: 'Часть имени клиента' },
      date: {
        type: 'string',
        description: 'Дата доставки в формате YYYY-MM-DD (опционально)',
      },
      mealType: {
        type: 'string',
        enum: ['BREAKFAST', 'LUNCH', 'DINNER'],
        description: 'Тип приёма пищи (опционально)',
      },
    },
    required: ['clientNameQuery'],
  },
  execute: async (rawInput) => {
    const input = rawInput as {
      clientNameQuery: string
      date?: string
      mealType?: MealType
    }

    // П6: строгий резолвер клиента вместо substring-матчинга. Если кандидат
    // не единственный — возвращаем спец-результат, Боря переспросит менеджера.
    const resolved = await resolveClient(input.clientNameQuery, prisma)
    if (!resolved.suggested) {
      const failure: ClientResolveFailure = {
        ok: false,
        reason: resolved.rejected === 'no_match' ? 'no_match' : 'ambiguous',
        candidates: resolved.matched.map((c) => ({ id: c.id, name: c.name })),
      }
      return failure
    }
    const suggested = resolved.suggested

    const where: Prisma.OrderWhereInput = {
      clientId: suggested.id,
    }
    if (input.date) where.deliveryDate = new Date(input.date)
    if (input.mealType) where.mealType = input.mealType

    const orders = await prisma.order.findMany({
      where,
      orderBy: { deliveryDate: 'desc' },
      take: MAX_LIST_ITEMS + 1,
      select: {
        id: true,
        mealType: true,
        deliveryDate: true,
        portions: true,
        status: true,
        updatedAt: true,
        client: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    })

    const mapped = orders.map((o) => ({
      orderId: o.id,
      client: { id: o.client.id, name: o.client.name },
      location: { id: o.location.id, name: o.location.name },
      mealType: MEAL_TYPE_RU[o.mealType],
      deliveryDate: formatDateHuman(o.deliveryDate),
      deliveryDateIso: formatDate(o.deliveryDate),
      portions: formatPortions(o.portions),
      portionsNumber: o.portions,
      status: ORDER_STATUS_RU[o.status],
      statusCode: o.status,
      updatedAt: o.updatedAt.toISOString(),
    }))

    // MEGA-4a-fix: SAME-DAY клиент на будущую дату — заказов ещё нет и руками их
    // создавать не нужно (клиент подтвердит сам утром). Возвращаем спец-reason,
    // а не пустой список, чтобы Боря объяснил менеджеру вместо предложения создать.
    if (mapped.length === 0 && input.date && resolved.isSameDayClient && isFutureMskDate(input.date)) {
      const failure: SameDayFutureFailure = {
        ok: false,
        reason: 'same_day_future',
        clientName: suggested.name,
        deliveryDate: input.date,
      }
      return failure
    }

    return truncate(mapped)
  },
}

const getOrderDetailsTool: AgentTool = {
  name: 'get_order_details',
  description: 'Получить полную информацию о заказе по id.',
  input_schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
    },
    required: ['orderId'],
  },
  execute: async (rawInput) => {
    const { orderId } = rawInput as { orderId: string }
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        client: { select: { id: true, name: true } },
        location: { select: { id: true, name: true, address: true } },
        delivery: true,
      },
    })
    if (!order) return { error: 'order_not_found', orderId }
    return {
      orderId: order.id,
      client: order.client,
      location: order.location,
      mealType: MEAL_TYPE_RU[order.mealType],
      mealTypeCode: order.mealType,
      deliveryDate: formatDateHuman(order.deliveryDate),
      deliveryDateIso: formatDate(order.deliveryDate),
      status: ORDER_STATUS_RU[order.status],
      statusCode: order.status,
      portions: formatPortions(order.portions),
      portionsNumber: order.portions,
      pricePerPortion: Number(order.pricePerPortion),
      totalPrice: Number(order.totalPrice),
      packaging: order.packaging,
      tags: order.tags,
      source: order.source,
      notes: order.notes,
      createdAt: order.createdAt.toISOString(),
      confirmedAt: order.confirmedAt?.toISOString() ?? null,
      lockedAt: order.lockedAt?.toISOString() ?? null,
      editedAfterLockAt: order.editedAfterLockAt?.toISOString() ?? null,
      updatedAt: order.updatedAt.toISOString(),
      delivery: order.delivery
        ? {
            type: order.delivery.type,
            status: order.delivery.status,
            courierName: order.delivery.courierName,
            notes: order.delivery.notes,
          }
        : null,
    }
  },
}

const getClientSummaryTool: AgentTool = {
  name: 'get_client_summary',
  description:
    'Найти клиента по части имени и вернуть его сводку: locations и активные meal-конфиги.',
  input_schema: {
    type: 'object',
    properties: {
      clientNameQuery: { type: 'string' },
    },
    required: ['clientNameQuery'],
  },
  execute: async (rawInput) => {
    const { clientNameQuery } = rawInput as { clientNameQuery: string }

    // П6: строгий резолвер. Неоднозначность → переспрос, не угадывание.
    const resolved = await resolveClient(clientNameQuery, prisma)
    if (!resolved.suggested) {
      const failure: ClientResolveFailure = {
        ok: false,
        reason: resolved.rejected === 'no_match' ? 'no_match' : 'ambiguous',
        candidates: resolved.matched.map((c) => ({ id: c.id, name: c.name })),
      }
      return failure
    }

    // Подтягиваем связи только для единственного подтверждённого клиента.
    const clients = await prisma.client.findMany({
      where: { id: resolved.suggested.id },
      include: {
        locations: {
          where: { isActive: true },
          include: {
            mealConfigs: {
              where: { isActive: true },
              select: {
                id: true,
                mealType: true,
                orderType: true,
                fixedPortions: true,
                pricePerPortion: true,
                scheduleType: true,
              },
            },
          },
        },
      },
    })

    return clients.map((c) => ({
      id: c.id,
      name: c.name,
      contactName: c.contactName,
      contactPhone: c.contactPhone,
      notes: c.notes,
      locations: c.locations.map((loc) => ({
        id: loc.id,
        name: loc.name,
        address: loc.address,
        packaging: loc.packaging,
        tags: loc.tags,
        activeMealConfigs: loc.mealConfigs.map((mc) => ({
          id: mc.id,
          mealType: MEAL_TYPE_RU[mc.mealType],
          mealTypeCode: mc.mealType,
          orderType: mc.orderType,
          fixedPortions: mc.fixedPortions,
          pricePerPortion: Number(mc.pricePerPortion),
          scheduleType: mc.scheduleType,
        })),
      })),
    }))
  },
}

const getOrdersForDateTool: AgentTool = {
  name: 'get_orders_for_date',
  description: 'Получить все заказы на указанную дату, сгруппированные по клиенту.',
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['date'],
  },
  execute: async (rawInput) => {
    const { date } = rawInput as { date: string }
    const orders = await prisma.order.findMany({
      where: { deliveryDate: new Date(date) },
      orderBy: [{ client: { name: 'asc' } }, { mealType: 'asc' }],
      take: MAX_LIST_ITEMS + 1,
      select: {
        id: true,
        mealType: true,
        portions: true,
        status: true,
        totalPrice: true,
        updatedAt: true,
        client: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    })

    const grouped: Record<string, {
      clientId: string
      clientName: string
      orders: Array<{
        orderId: string
        location: string
        mealType: string
        mealTypeCode: MealType
        portions: string
        portionsNumber: number
        status: string
        statusCode: string
        totalPrice: number
        updatedAt: string
      }>
    }> = {}

    for (const o of orders.slice(0, MAX_LIST_ITEMS)) {
      const key = o.client.id
      if (!grouped[key]) {
        grouped[key] = { clientId: o.client.id, clientName: o.client.name, orders: [] }
      }
      grouped[key].orders.push({
        orderId: o.id,
        location: o.location.name,
        mealType: MEAL_TYPE_RU[o.mealType],
        mealTypeCode: o.mealType,
        portions: formatPortions(o.portions),
        portionsNumber: o.portions,
        status: ORDER_STATUS_RU[o.status],
        statusCode: o.status,
        totalPrice: Number(o.totalPrice),
        updatedAt: o.updatedAt.toISOString(),
      })
    }

    return {
      date,
      dateHuman: formatDateHuman(date),
      clients: Object.values(grouped),
      truncated: orders.length > MAX_LIST_ITEMS,
      totalOrders: orders.length > MAX_LIST_ITEMS ? `>${MAX_LIST_ITEMS}` : orders.length,
    }
  },
}

const getMenuForDateTool: AgentTool = {
  name: 'get_menu_for_date',
  description:
    'Получить блюда меню на указанную дату из активного MenuCycle. Возвращает блюда по типам приёма пищи.',
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['date'],
  },
  execute: async (rawInput) => {
    const { date } = rawInput as { date: string }
    const target = new Date(date)
    // dayOfWeek: ISO 8601 1=Mon..7=Sun
    const jsDay = target.getUTCDay() // 0=Sun..6=Sat
    const dayOfWeek = jsDay === 0 ? 7 : jsDay

    const cycle = await prisma.menuCycle.findFirst({
      where: {
        status: 'APPROVED',
        validFrom: { lte: target },
        validTo: { gte: target },
      },
      include: {
        days: {
          where: { dayOfWeek },
          include: {
            dishes: {
              include: {
                dish: {
                  select: { id: true, name: true, category: true, correctedName: true },
                },
              },
            },
          },
        },
      },
    })

    if (!cycle) {
      return { date, dayOfWeek, found: false, note: 'no_approved_cycle_for_date' }
    }

    return {
      date,
      dateHuman: formatDateHuman(date),
      dayOfWeek,
      cycleId: cycle.id,
      cycleName: cycle.name,
      days: cycle.days.map((day) => ({
        mealType: MEAL_TYPE_RU[day.mealType],
        mealTypeCode: day.mealType,
        dishes: day.dishes.map((dd) => ({
          dishId: dd.dish.id,
          name: dd.dish.correctedName ?? dd.dish.name,
          category: dd.dish.category,
          slotCategory: dd.slotCategory,
        })),
      })),
    }
  },
}

const getDishMarginTool: AgentTool = {
  name: 'get_dish_margin',
  description:
    'Маржа блюда: (price - cost) / price. Если указан dishId — для одного блюда; если date — средняя по блюдам этого дня. По крайней мере один параметр обязателен.',
  input_schema: {
    type: 'object',
    properties: {
      dishId: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
    },
  },
  execute: async (rawInput) => {
    const input = rawInput as { dishId?: string; date?: string }

    // У блюда нет прямого "price" в схеме (цены на уровне заказов). Считаем cost
    // из техкарты, а как proxy для price — pricePerPortion из последнего заказа
    // на это блюдо. Если данных нет — возвращаем cost-only.
    async function computeDishCost(dishId: string): Promise<number> {
      const ingredients = await prisma.dishIngredient.findMany({
        where: { dishId },
        include: { ingredient: { select: { pricePerUnit: true, unit: true } } },
      })
      let cost = 0
      for (const di of ingredients) {
        // pricePerUnit за KG/L/PCS — bruttoGrams в граммах. Конвертация: для KG/L
        // делим на 1000; для PCS считаем грамма как штуки (приближение для MVP).
        const brutto = Number(di.bruttoGrams)
        const ppu = Number(di.ingredient.pricePerUnit)
        const factor = di.ingredient.unit === 'PCS' ? 1 : 1000
        cost += (brutto / factor) * ppu
      }
      return cost
    }

    if (input.dishId) {
      const dish = await prisma.dish.findUnique({
        where: { id: input.dishId },
        select: { id: true, name: true, correctedName: true },
      })
      if (!dish) return { error: 'dish_not_found', dishId: input.dishId }
      const cost = await computeDishCost(dish.id)
      return {
        dishId: dish.id,
        name: dish.correctedName ?? dish.name,
        costPerPortion: Math.round(cost * 100) / 100,
        note: 'price_not_attached_to_dish_use_order_average',
      }
    }

    if (input.date) {
      const target = new Date(input.date)
      const jsDay = target.getUTCDay()
      const dayOfWeek = jsDay === 0 ? 7 : jsDay
      const cycle = await prisma.menuCycle.findFirst({
        where: {
          status: 'APPROVED',
          validFrom: { lte: target },
          validTo: { gte: target },
        },
        include: {
          days: {
            where: { dayOfWeek },
            include: { dishes: { include: { dish: true } } },
          },
        },
      })
      if (!cycle) return { date: input.date, error: 'no_menu_for_date' }

      const dishCosts = []
      for (const day of cycle.days) {
        for (const dd of day.dishes) {
          const cost = await computeDishCost(dd.dish.id)
          dishCosts.push({
            dishId: dd.dish.id,
            name: dd.dish.correctedName ?? dd.dish.name,
            mealType: MEAL_TYPE_RU[day.mealType],
            mealTypeCode: day.mealType,
            costPerPortion: Math.round(cost * 100) / 100,
          })
        }
      }

      const avgCost =
        dishCosts.length === 0
          ? 0
          : dishCosts.reduce((s, d) => s + d.costPerPortion, 0) / dishCosts.length

      return {
        date: input.date,
        cycleId: cycle.id,
        averageCostPerDish: Math.round(avgCost * 100) / 100,
        dishes: dishCosts,
        note: 'margin_requires_dish_price_not_in_schema',
      }
    }

    return { error: 'missing_params', message: 'dishId или date обязателен' }
  },
}

const getRecentClientMessagesTool: AgentTool = {
  name: 'get_recent_client_messages',
  description:
    'Последние входящие сообщения клиента из MAX-бота (BotMessage direction=IN). Полезно для понимания контекста разговора.',
  input_schema: {
    type: 'object',
    properties: {
      clientId: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    required: ['clientId'],
  },
  execute: async (rawInput) => {
    const input = rawInput as { clientId: string; limit?: number }
    const limit = Math.min(input.limit ?? 10, 20)

    const messages = await prisma.botMessage.findMany({
      where: { clientId: input.clientId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        direction: true,
        text: true,
        toneLabel: true,
        createdAt: true,
      },
    })

    return {
      clientId: input.clientId,
      messages: messages.reverse().map((m) => ({
        direction: m.direction,
        text: m.text.length > 500 ? m.text.slice(0, 500) + '…' : m.text,
        toneLabel: m.toneLabel,
        createdAt: m.createdAt.toISOString(),
      })),
    }
  },
}

// ============================================================
// MUTATE tools — возвращают pending action для подтверждения
// ============================================================

type PendingResult = {
  pending: true
  action?: { tool: string; input: Record<string, unknown> }
  preview: string
  error?: string
}

async function buildOrderPreviewLine(orderId: string): Promise<string> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    include: { client: { select: { name: true } }, location: { select: { name: true } } },
  })
  if (!o) return `Заказ ${orderId} (не найден)`
  return `${escapeHtml(o.client.name)}, ${escapeHtml(o.location.name)}, ${formatDate(o.deliveryDate)}, ${MEAL_TYPE_RU[o.mealType]}`
}

const editOrderPortionsTool: AgentTool = {
  name: 'edit_order_portions',
  description:
    'Запланировать изменение количества порций в заказе. Требует подтверждения у пользователя. КРИТИЧНО: параметр portions — это АБСОЛЮТНОЕ финальное значение. Перед использованием этого tool ОБЯЗАТЕЛЬНО вызови find_orders для получения актуального portions из БД, даже если ты её получал ранее в этом разговоре. История conversation не отражает изменения БД от прошлых подтверждённых mutation или ручных правок через CRM. Передача устаревшего значения = финансовая ошибка на десятки порций.',
  input_schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      portions: { type: 'integer', minimum: 0 },
      expectedUpdatedAt: {
        type: 'string',
        description: 'ISO timestamp полученный из find_orders (для optimistic lock)',
      },
    },
    required: ['orderId', 'portions'],
  },
  execute: async (rawInput): Promise<PendingResult> => {
    const input = rawInput as {
      orderId: string
      portions: number
      expectedUpdatedAt?: string
    }
    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      include: { client: { select: { name: true } }, location: { select: { name: true } } },
    })
    if (!order) {
      return { pending: true, error: 'order_not_found', preview: `Заказ ${input.orderId} не найден` }
    }
    const preview = `${escapeHtml(order.client.name)}, ${escapeHtml(order.location.name)}, ${formatDate(order.deliveryDate)}, ${MEAL_TYPE_RU[order.mealType]}: ${order.portions} → ${input.portions} порций`
    return {
      pending: true,
      action: { tool: 'edit_order_portions', input: input as unknown as Record<string, unknown> },
      preview,
    }
  },
}

const cancelOrderTool: AgentTool = {
  name: 'cancel_order',
  description:
    'Запланировать отмену заказа. Требует подтверждения у пользователя. Перед отменой убедись через find_orders что заказ всё ещё активен.',
  input_schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      reason: { type: 'string', description: 'Причина отмены (опционально)' },
      expectedUpdatedAt: { type: 'string' },
    },
    required: ['orderId'],
  },
  execute: async (rawInput): Promise<PendingResult> => {
    const input = rawInput as { orderId: string; reason?: string; expectedUpdatedAt?: string }
    const line = await buildOrderPreviewLine(input.orderId)
    const reasonPart = input.reason ? ` — причина: ${escapeHtml(input.reason)}` : ''
    return {
      pending: true,
      action: { tool: 'cancel_order', input: input as unknown as Record<string, unknown> },
      preview: `Отмена: ${line}${reasonPart}`,
    }
  },
}

const restoreOrderTool: AgentTool = {
  name: 'restore_order',
  description:
    'Запланировать восстановление ранее отменённого заказа. Требует подтверждения у пользователя. Перед восстановлением убедись через find_orders что заказ всё ещё в CANCELLED статусе.',
  input_schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      expectedUpdatedAt: { type: 'string' },
    },
    required: ['orderId'],
  },
  execute: async (rawInput): Promise<PendingResult> => {
    const input = rawInput as { orderId: string; expectedUpdatedAt?: string }
    const line = await buildOrderPreviewLine(input.orderId)
    return {
      pending: true,
      action: { tool: 'restore_order', input: input as unknown as Record<string, unknown> },
      preview: `Восстановление: ${line}`,
    }
  },
}

const createOneTimeOrderTool: AgentTool = {
  name: 'create_one_time_order',
  description:
    'Запланировать создание разового заказа (не привязан к расписанию). Требует подтверждения.',
  input_schema: {
    type: 'object',
    properties: {
      clientId: { type: 'string' },
      locationId: { type: 'string' },
      mealType: { type: 'string', enum: ['BREAKFAST', 'LUNCH', 'DINNER'] },
      deliveryDate: { type: 'string', description: 'YYYY-MM-DD' },
      portions: { type: 'integer', minimum: 1 },
      pricePerPortion: { type: 'number', minimum: 0 },
    },
    required: ['clientId', 'locationId', 'mealType', 'deliveryDate', 'portions'],
  },
  execute: async (rawInput): Promise<PendingResult | SameDayFutureFailure> => {
    const input = rawInput as {
      clientId: string
      locationId: string
      mealType: string
      deliveryDate: string
      portions: number
      pricePerPortion?: number
    }

    // MEGA-4a-fix: блокируем ручную предзаявку SAME-DAY клиенту на будущую дату.
    // Он подтвердит заказ сам утром в день доставки (daily-questions-sameday).
    if (isFutureMskDate(input.deliveryDate)) {
      const sameDayLoc = await prisma.clientLocation.findFirst({
        where: { clientId: input.clientId, isActive: true, sameDayDelivery: true },
        select: { id: true },
      })
      if (sameDayLoc) {
        const c = await prisma.client.findUnique({
          where: { id: input.clientId },
          select: { name: true },
        })
        return {
          ok: false,
          reason: 'same_day_future_create_blocked',
          clientName: c?.name ?? input.clientId,
          deliveryDate: input.deliveryDate,
        }
      }
    }

    const [client, location] = await Promise.all([
      prisma.client.findUnique({ where: { id: input.clientId }, select: { name: true } }),
      prisma.clientLocation.findUnique({
        where: { id: input.locationId },
        select: { name: true },
      }),
    ])
    if (!client) {
      return { pending: true, error: 'client_not_found', preview: `Клиент ${input.clientId} не найден` }
    }
    if (!location) {
      return {
        pending: true,
        error: 'location_not_found',
        preview: `Точка ${input.locationId} не найдена`,
      }
    }
    const pricePart = input.pricePerPortion ? `, цена ${input.pricePerPortion} ₽/порция` : ''
    // input.mealType приходит string из LLM, но enum-валидация в input_schema
    // гарантирует, что это валидный MealType — cast безопасный.
    const mealTypeRu = MEAL_TYPE_RU[input.mealType as MealType] ?? input.mealType
    const preview = `Новый разовый: ${escapeHtml(client.name)}, ${escapeHtml(location.name)}, ${escapeHtml(input.deliveryDate)}, ${mealTypeRu}, ${input.portions} порций${pricePart}`
    return {
      pending: true,
      action: {
        tool: 'create_one_time_order',
        input: input as unknown as Record<string, unknown>,
      },
      preview,
    }
  },
}

const rescheduleOrderTool: AgentTool = {
  name: 'reschedule_order',
  description:
    'Запланировать перенос заказа на другую дату. Требует подтверждения у пользователя. Перед переносом вызови find_orders для актуального deliveryDate.',
  input_schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      newDate: { type: 'string', description: 'Новая дата YYYY-MM-DD' },
      expectedUpdatedAt: { type: 'string' },
    },
    required: ['orderId', 'newDate'],
  },
  execute: async (rawInput): Promise<PendingResult> => {
    const input = rawInput as { orderId: string; newDate: string; expectedUpdatedAt?: string }
    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      include: { client: { select: { name: true } }, location: { select: { name: true } } },
    })
    if (!order) {
      return { pending: true, error: 'order_not_found', preview: `Заказ ${input.orderId} не найден` }
    }
    const preview = `Перенос: ${escapeHtml(order.client.name)}, ${escapeHtml(order.location.name)}, ${MEAL_TYPE_RU[order.mealType]}: ${formatDate(order.deliveryDate)} → ${escapeHtml(input.newDate)}`
    return {
      pending: true,
      action: { tool: 'reschedule_order', input: input as unknown as Record<string, unknown> },
      preview,
    }
  },
}

const addOrderNoteTool: AgentTool = {
  name: 'add_order_note',
  description:
    'Запланировать добавление заметки к заказу (видна шефу/курьеру). Требует подтверждения.',
  input_schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      note: { type: 'string', minLength: 1 },
      expectedUpdatedAt: { type: 'string' },
    },
    required: ['orderId', 'note'],
  },
  execute: async (rawInput): Promise<PendingResult> => {
    const input = rawInput as { orderId: string; note: string; expectedUpdatedAt?: string }
    const line = await buildOrderPreviewLine(input.orderId)
    const shortNote = input.note.length > 80 ? input.note.slice(0, 80) + '…' : input.note
    return {
      pending: true,
      action: { tool: 'add_order_note', input: input as unknown as Record<string, unknown> },
      preview: `Заметка к ${line}: «${escapeHtml(shortNote)}»`,
    }
  },
}

// ============================================================
// Export
// ============================================================

const READ_TOOL_NAMES = [
  'find_orders',
  'get_order_details',
  'get_client_summary',
  'get_orders_for_date',
  'get_menu_for_date',
  'get_dish_margin',
  'get_recent_client_messages',
] as const

const MUTATE_TOOL_NAMES = [
  'edit_order_portions',
  'cancel_order',
  'restore_order',
  'create_one_time_order',
  'reschedule_order',
  'add_order_note',
] as const

export const BORIS_TOOLS: AgentTool[] = [
  // READ
  findOrdersTool,
  getOrderDetailsTool,
  getClientSummaryTool,
  getOrdersForDateTool,
  getMenuForDateTool,
  getDishMarginTool,
  getRecentClientMessagesTool,
  // MUTATE (return pending)
  editOrderPortionsTool,
  cancelOrderTool,
  restoreOrderTool,
  createOneTimeOrderTool,
  rescheduleOrderTool,
  addOrderNoteTool,
]

/** Только READ-tools. Используется в группе ИЛИ для не-ADMIN_PRO ролей. */
export const BORIS_READ_TOOLS: AgentTool[] = BORIS_TOOLS.filter((t) =>
  (READ_TOOL_NAMES as readonly string[]).includes(t.name),
)

/** Только MUTATE-tools. Не используется напрямую — для тестов / type-safety. */
export const BORIS_MUTATE_TOOLS: AgentTool[] = BORIS_TOOLS.filter((t) =>
  (MUTATE_TOOL_NAMES as readonly string[]).includes(t.name),
)
