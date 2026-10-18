import { prisma } from '@/lib/db/prisma'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import type { OrderStatus, MealType, Prisma } from '@prisma/client'

export interface OrderListFilter {
  dateFrom?: Date
  dateTo?: Date
  clientId?: string
  mealType?: MealType
  status?: OrderStatus
  search?: string
  /** 'meal' (по умолчанию): тип питания → клиент; 'client': клиент → тип питания. */
  sort?: OrderListSort
}

export type OrderListSort = 'meal' | 'client'

/**
 * Список заказов для табличного режима. Сортировка по дате доставки, затем
 * по умолчанию — тип питания (завтрак → обед → ужин) и имя клиента; при
 * sort='client' — имя клиента, затем тип питания.
 */
export async function listOrders(filter: OrderListFilter, limit = 200) {
  const where: Prisma.OrderWhereInput = {}

  if (filter.dateFrom || filter.dateTo) {
    where.deliveryDate = {}
    if (filter.dateFrom) where.deliveryDate.gte = filter.dateFrom
    if (filter.dateTo) where.deliveryDate.lte = filter.dateTo
  }
  if (filter.clientId) where.clientId = filter.clientId
  if (filter.mealType) where.mealType = filter.mealType
  if (filter.status) where.status = filter.status

  if (filter.search && filter.search.trim()) {
    const q = filter.search.trim()
    where.OR = [
      { client: { name: { contains: q, mode: 'insensitive' } } },
      { location: { name: { contains: q, mode: 'insensitive' } } },
      { client: { contactName: { contains: q, mode: 'insensitive' } } },
      // contactPhone хранится в формате '+7 (999) 999-99-99' — case не важен,
      // но пробелы/скобки в search'е сломают match. Менеджер вводит как видит.
      { client: { contactPhone: { contains: q } } },
    ]
  }

  return prisma.order.findMany({
    where,
    take: limit,
    // Порядок enum MealType в PostgreSQL: BREAKFAST, LUNCH, DINNER.
    orderBy:
      filter.sort === 'client'
        ? [{ deliveryDate: 'asc' }, { client: { name: 'asc' } }, { mealType: 'asc' }]
        : [{ deliveryDate: 'asc' }, { mealType: 'asc' }, { client: { name: 'asc' } }],
    include: {
      client: { select: { id: true, name: true } },
      // deliveryFee (Decimal?) — для сводки «Доставка»/«Общая сумма» в шапке
      // списка. serialize() в page.tsx конвертирует Decimal → number|null.
      location: { select: { id: true, name: true, address: true, deliveryFee: true } },
      delivery: { select: { issueReportedAt: true } },
    },
  })
}

/**
 * Заказы для календарной сетки на неделю — те же фильтры,
 * но с агрегацией по дате/клиенту/типу.
 *
 * weekStart — понедельник: МСК-инстант полуночи (getMondayOfWeek, Вс 21:00Z)
 * или UTC-полночь понедельника. Для @db.Date нормализуем к UTC-полуночи
 * МСК-понедельника: [Пн 00:00Z, след. Пн 00:00Z). Раньше МСК-инстант уходил в
 * фильтр как есть → Prisma усекал до ВОСКРЕСЕНЬЯ: прошлое Вс попадало, текущее
 * Вс — нет (колонка «Вс» всегда пустая).
 */
export async function listOrdersForWeek(weekStart: Date) {
  const monday = getMskCalendarDayUtc(weekStart, 0)
  const nextMonday = getMskCalendarDayUtc(weekStart, 7)

  const orders = await prisma.order.findMany({
    where: {
      deliveryDate: {
        gte: monday,
        lt: nextMonday,
      },
      status: { not: 'CANCELLED' },
    },
    orderBy: [
      { deliveryDate: 'asc' },
      { client: { name: 'asc' } },
    ],
    include: {
      client: { select: { id: true, name: true } },
    },
  })

  return orders
}

/**
 * Список клиентов для фильтра-выпадашки.
 */
export async function listActiveClientsLight() {
  return prisma.client.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
}

/**
 * Сколько заказов ждут подтверждения (для бейджа на дашборде).
 */
export async function countPendingConfirmation() {
  return prisma.order.count({
    where: { status: 'PENDING_CONFIRMATION' },
  })
}

/**
 * МСК-сегодня и МСК-завтра как UTC-полночи (@db.Date). Раньше date-fns
 * startOfDay(new Date()) на UTC-сервере в 00:00–03:00 МСК давал «вчера+сегодня».
 */
function mskTodayTomorrow(now: Date = new Date()): { today: Date; tomorrow: Date } {
  return { today: getMskCalendarDayUtc(now, 0), tomorrow: getMskCalendarDayUtc(now, 1) }
}

/**
 * Подтверждение DYNAMIC до 18:00. Возвращает все заказы со статусом
 * PENDING_CONFIRMATION на сегодня и завтра.
 *
 * Использование:
 * - countPendingConfirmation для бейджей и шапки
 * - listPendingConfirmation для экрана быстрого ввода
 */
export async function countPendingConfirmationToday() {
  const { today, tomorrow } = mskTodayTomorrow()
  return prisma.order.count({
    where: {
      status: 'PENDING_CONFIRMATION',
      deliveryDate: { gte: today, lte: tomorrow },
    },
  })
}

export async function listPendingConfirmation() {
  const { today, tomorrow } = mskTodayTomorrow()
  return prisma.order.findMany({
    where: {
      status: 'PENDING_CONFIRMATION',
      deliveryDate: { gte: today, lte: tomorrow },
    },
    orderBy: [
      { deliveryDate: 'asc' },
      { client: { name: 'asc' } },
      { mealType: 'asc' },
    ],
    include: {
      client: { select: { id: true, name: true } },
      // 7.40: cutoff-поля локации — для per-location отсчёта в confirm-list.
      location: {
        select: {
          id: true,
          name: true,
          address: true,
          cutoffHourMsk: true,
          cutoffMinuteMsk: true,
          sameDayDelivery: true,
        },
      },
      sourceConfig: { select: { id: true, fixedPortions: true } },
    },
  })
}

/**
 * 7.40: данные для виджетов cut-off на дашборде (CutOffBlock, ActionRequiredBlock).
 * Pending DYNAMIC-заказы на сегодня и завтра + cutoff-поля их локаций. Лёгкая
 * выборка (без клиента/цен): UI считает per-location момент через
 * getCutoffMoment(deliveryDate, cutoffHourMsk ?? 16, cutoffMinuteMsk ?? 0, sameDayDelivery)
 * и выбирает ближайший ещё не наступивший. Один источник для обоих виджетов —
 * чтобы не плодить параллельные запросы в одинаковой семантикой.
 */
export async function listPendingCutoffData() {
  const { today, tomorrow } = mskTodayTomorrow()
  return prisma.order.findMany({
    where: {
      status: 'PENDING_CONFIRMATION',
      deliveryDate: { gte: today, lte: tomorrow },
    },
    select: {
      deliveryDate: true,
      location: {
        select: {
          cutoffHourMsk: true,
          cutoffMinuteMsk: true,
          sameDayDelivery: true,
        },
      },
    },
  })
}

/**
 * Возвращает заказ со всеми связями для детальной карточки
 * + историю изменений из ActivityLog по этому orderId.
 */
export async function getOrderDetail(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      client: { select: { id: true, name: true, contactName: true, contactPhone: true } },
      location: { select: { id: true, name: true, address: true, packaging: true, tags: true, deliveryWindowFrom: true, deliveryWindowTo: true, deliveryFee: true } },
      sourceConfig: { select: { id: true, orderType: true, scheduleType: true, fixedPortions: true } },
      createdBy: { select: { id: true, name: true, role: true } },
      delivery: { select: { id: true, status: true, deliveredAt: true, courierName: true, issueReportedAt: true, issueReason: true, issueComment: true, issueReportedById: true } },
      ourLegalEntity: { select: { id: true, shortName: true, entityType: true, vatMode: true, vatRate: true } },
    },
  })

  if (!order) return null

  const history = await prisma.activityLog.findMany({
    where: {
      entityType: 'Order',
      entityId: orderId,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      user: { select: { id: true, name: true, role: true } },
    },
  })

  return { order, history }
}

/**
 * MEGA-4b (П3): найти активный (не отменённый) заказ по бизнес-ключу
 * {clientId, locationId, mealType, deliveryDate}.
 *
 * Используется при подтверждении запроса клиента на изменение порций:
 * перепроверяем, что заказ всё ещё существует и его статус не блокирует
 * правку. Если по ключу несколько заказов — берём самый свежий по updatedAt
 * (нормально для исторических дублей; антидубль на создании уже гарантирует
 * один живой заказ на день).
 */
export async function findActiveOrder(params: {
  clientId: string
  locationId: string
  mealType: MealType
  deliveryDate: Date
}): Promise<{ id: string; status: OrderStatus; portions: number; updatedAt: Date } | null> {
  return prisma.order.findFirst({
    where: {
      clientId: params.clientId,
      locationId: params.locationId,
      mealType: params.mealType,
      deliveryDate: params.deliveryDate,
      status: { not: 'CANCELLED' },
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, status: true, portions: true, updatedAt: true },
  })
}
