import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ParseResult } from './parser'
import type { SanityResult } from './sanity-checks'
import type { OrderStatus } from '@prisma/client'

/**
 * MEGA-2 actions: order-creation / rollback для недельных заявок.
 *
 * Мокаем @/lib/db/prisma (методы, которые дёргают actions) и
 * @/lib/orders/legal-entity-snapshot (snapshot юрлица — без БД в тесте).
 * $transaction в проде получает массив PrismaPromise'ов от prisma.order.create;
 * в моке create возвращает готовый объект {id}, а $transaction просто
 * резолвит переданный массив (Promise.all) — так мы проверяем и состав заказов.
 */

// --- Моки. vi.hoisted: фабрики vi.mock поднимаются в начало файла, поэтому
// сами моки нужно создать через hoisted, иначе ReferenceError (TDZ). ---
const { mockPrisma, mockSnapshot } = vi.hoisted(() => ({
  mockPrisma: {
    weeklyOrderSubmission: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    clientMealConfig: {
      findFirst: vi.fn(),
    },
    menuCycle: {
      findFirst: vi.fn(),
    },
    order: {
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockSnapshot: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: mockPrisma,
}))

vi.mock('@/lib/orders/legal-entity-snapshot', () => ({
  getOrderLegalEntitySnapshot: (clientId: string) => mockSnapshot(clientId),
}))

// Импорт ПОСЛЕ vi.mock (hoisting гарантирует, что моки уже на месте).
import { processWeeklySubmission, cancelWeeklySubmission } from './actions'

const CLIENT_ID = 'client_1'
const SUBMISSION_ID = 'sub_1'
const CONFIG = {
  id: 'cfg_1',
  locationId: 'loc_1',
  mealType: 'LUNCH' as const,
  pricePerPortion: '300.00',
  location: { packaging: 'INDIVIDUAL' as const },
}

function makeParsed(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    items: [
      { date: '2026-06-01', portions: 20 },
      { date: '2026-06-02', portions: 18 },
      { date: '2026-06-03', portions: 22 },
    ],
    dietaryNotes: 'всегда без свинины',
    confidence: 1,
    reason: 'чёткое фото',
    ...overrides,
  }
}

const okSanity: SanityResult = { ok: true, failures: [] }
const WEEK_START = new Date('2026-05-31T21:00:00.000Z') // МСК-полночь Пн 1 июн

beforeEach(() => {
  vi.clearAllMocks()
  // create заявки → возвращаем id
  mockPrisma.weeklyOrderSubmission.create.mockResolvedValue({ id: SUBMISSION_ID })
  mockPrisma.weeklyOrderSubmission.update.mockResolvedValue({ id: SUBMISSION_ID })
  // snapshot юрлица по умолчанию — заполнен
  mockSnapshot.mockResolvedValue({ ourLegalEntityId: 'ole_1', vatRate: '10.00' })
  // $transaction: исполняем переданный массив операций (Promise.all)
  mockPrisma.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops))
})

describe('processWeeklySubmission', () => {
  it('PARSED + sanity ok + меню есть → AUTO_CONFIRMED, N заказов WEEKLY_AUTO/CONFIRMED', async () => {
    mockPrisma.clientMealConfig.findFirst.mockResolvedValue(CONFIG)
    mockPrisma.menuCycle.findFirst.mockResolvedValue({ id: 'menu_1' }) // меню на любую дату
    let seq = 0
    mockPrisma.order.create.mockImplementation(() => Promise.resolve({ id: `order_${++seq}` }))

    const parsed = makeParsed()
    const result = await processWeeklySubmission({
      clientId: CLIENT_ID,
      source: 'PHOTO',
      blobUrl: 'https://blob/photo.jpg',
      parsedResult: parsed,
      sanityResult: okSanity,
      weekStartDate: WEEK_START,
    })

    expect(result.status).toBe('AUTO_CONFIRMED')
    expect(result.submissionId).toBe(SUBMISSION_ID)
    expect(result.createdOrderIds).toEqual(['order_1', 'order_2', 'order_3'])

    // Ровно 3 заказа созданы
    expect(mockPrisma.order.create).toHaveBeenCalledTimes(3)

    // Проверяем shape первого заказа
    const firstCall = mockPrisma.order.create.mock.calls[0][0]
    expect(firstCall.data).toMatchObject({
      clientId: CLIENT_ID,
      locationId: 'loc_1',
      mealType: 'LUNCH',
      portions: 20,
      pricePerPortion: 300,
      totalPrice: 6000, // 20 * 300
      packaging: 'INDIVIDUAL',
      status: 'CONFIRMED',
      source: 'WEEKLY_AUTO',
      weeklySubmissionId: SUBMISSION_ID,
      sourceConfigId: 'cfg_1',
      notes: 'всегда без свинины',
      ourLegalEntityId: 'ole_1',
      vatRate: '10.00',
    })
    // deliveryDate — UTC-полночь календарной даты 2026-06-01
    expect(firstCall.data.deliveryDate.toISOString()).toBe('2026-06-01T00:00:00.000Z')

    // Заказы шли через транзакцию
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)

    // Финальный апдейт статуса заявки
    expect(mockPrisma.weeklyOrderSubmission.update).toHaveBeenCalledWith({
      where: { id: SUBMISSION_ID },
      data: { status: 'AUTO_CONFIRMED' },
    })
  })

  it('sanity fail → NEEDS_REVIEW, 0 заказов, failureReason из failures', async () => {
    const sanity: SanityResult = {
      ok: false,
      failures: ['confidence ниже порога', 'дней больше ожидаемого'],
    }

    const result = await processWeeklySubmission({
      clientId: CLIENT_ID,
      source: 'TEXT',
      rawText: '01.06 — 20',
      parsedResult: makeParsed({ confidence: 0.5 }),
      sanityResult: sanity,
      weekStartDate: WEEK_START,
    })

    expect(result.status).toBe('NEEDS_REVIEW')
    expect(result.createdOrderIds).toEqual([])
    expect(mockPrisma.order.create).not.toHaveBeenCalled()
    expect(mockPrisma.clientMealConfig.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.weeklyOrderSubmission.update).toHaveBeenCalledWith({
      where: { id: SUBMISSION_ID },
      data: {
        status: 'NEEDS_REVIEW',
        failureReason: 'confidence ниже порога; дней больше ожидаемого',
      },
    })
  })

  it('нет активного WEEKLY-конфига → NEEDS_REVIEW, 0 заказов', async () => {
    mockPrisma.clientMealConfig.findFirst.mockResolvedValue(null)

    const result = await processWeeklySubmission({
      clientId: CLIENT_ID,
      source: 'PHOTO',
      parsedResult: makeParsed(),
      sanityResult: okSanity,
      weekStartDate: WEEK_START,
    })

    expect(result.status).toBe('NEEDS_REVIEW')
    expect(result.createdOrderIds).toEqual([])
    expect(mockPrisma.order.create).not.toHaveBeenCalled()
    expect(mockPrisma.weeklyOrderSubmission.update).toHaveBeenCalledWith({
      where: { id: SUBMISSION_ID },
      data: { status: 'NEEDS_REVIEW', failureReason: 'no active WEEKLY config' },
    })
  })

  it('меню отсутствует на одну из дат → NEEDS_REVIEW, 0 заказов (проверка ДО создания)', async () => {
    mockPrisma.clientMealConfig.findFirst.mockResolvedValue(CONFIG)
    // Меню есть для 06-01 и 06-02, но НЕТ для 06-03.
    mockPrisma.menuCycle.findFirst.mockImplementation(
      (args: { where: { validFrom: { lte: Date } } }) => {
        const date = args.where.validFrom.lte
        const iso = date.toISOString().slice(0, 10)
        return Promise.resolve(iso === '2026-06-03' ? null : { id: 'menu_x' })
      }
    )

    const result = await processWeeklySubmission({
      clientId: CLIENT_ID,
      source: 'PHOTO',
      parsedResult: makeParsed(),
      sanityResult: okSanity,
      weekStartDate: WEEK_START,
    })

    expect(result.status).toBe('NEEDS_REVIEW')
    expect(result.createdOrderIds).toEqual([])
    // НИ одного заказа не создано (всё-или-ничего)
    expect(mockPrisma.order.create).not.toHaveBeenCalled()
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockPrisma.weeklyOrderSubmission.update).toHaveBeenCalledWith({
      where: { id: SUBMISSION_ID },
      data: { status: 'NEEDS_REVIEW', failureReason: 'no menu for 2026-06-03' },
    })
  })

  it('сбой при создании заказа → FAILED, заказов нет (транзакция откатила)', async () => {
    mockPrisma.clientMealConfig.findFirst.mockResolvedValue(CONFIG)
    mockPrisma.menuCycle.findFirst.mockResolvedValue({ id: 'menu_1' })
    mockPrisma.order.create.mockRejectedValue(new Error('db exploded'))

    const result = await processWeeklySubmission({
      clientId: CLIENT_ID,
      source: 'PHOTO',
      parsedResult: makeParsed(),
      sanityResult: okSanity,
      weekStartDate: WEEK_START,
    })

    expect(result.status).toBe('FAILED')
    expect(result.createdOrderIds).toEqual([])
    expect(mockPrisma.weeklyOrderSubmission.update).toHaveBeenCalledWith({
      where: { id: SUBMISSION_ID },
      data: { status: 'FAILED', failureReason: 'db exploded' },
    })
  })
})

describe('cancelWeeklySubmission', () => {
  it('все заказы CONFIRMED → все DRAFT, cancelled===N, статус CANCELLED', async () => {
    const orders = [
      { id: 'o1', status: 'CONFIRMED' as OrderStatus },
      { id: 'o2', status: 'CONFIRMED' as OrderStatus },
      { id: 'o3', status: 'CONFIRMED' as OrderStatus },
    ]
    mockPrisma.weeklyOrderSubmission.findUnique.mockResolvedValue({
      id: SUBMISSION_ID,
      orders,
    })
    mockPrisma.order.update.mockResolvedValue({})

    const result = await cancelWeeklySubmission({
      submissionId: SUBMISSION_ID,
      cancelledById: 'user_1',
    })

    expect(result.cancelled).toBe(3)
    expect(result.notCancelled).toEqual([])
    expect(mockPrisma.order.update).toHaveBeenCalledTimes(3)
    // каждый апдейт → DRAFT
    for (const call of mockPrisma.order.update.mock.calls) {
      expect(call[0].data).toEqual({ status: 'DRAFT' })
    }
    // заявка → CANCELLED с аудит-полями
    const subUpdate = mockPrisma.weeklyOrderSubmission.update.mock.calls.at(-1)![0]
    expect(subUpdate.where).toEqual({ id: SUBMISSION_ID })
    expect(subUpdate.data.status).toBe('CANCELLED')
    expect(subUpdate.data.cancelledById).toBe('user_1')
    expect(subUpdate.data.cancelledAt).toBeInstanceOf(Date)
  })

  it('1 LOCKED среди 5 → cancelled===4, notCancelled содержит LOCKED, LOCKED не тронут', async () => {
    const orders = [
      { id: 'o1', status: 'CONFIRMED' as OrderStatus },
      { id: 'o2', status: 'CONFIRMED' as OrderStatus },
      { id: 'o3', status: 'LOCKED' as OrderStatus },
      { id: 'o4', status: 'CONFIRMED' as OrderStatus },
      { id: 'o5', status: 'CONFIRMED' as OrderStatus },
    ]
    mockPrisma.weeklyOrderSubmission.findUnique.mockResolvedValue({
      id: SUBMISSION_ID,
      orders,
    })
    mockPrisma.order.update.mockResolvedValue({})

    const result = await cancelWeeklySubmission({
      submissionId: SUBMISSION_ID,
      cancelledById: 'user_1',
    })

    expect(result.cancelled).toBe(4)
    expect(result.notCancelled).toEqual([{ orderId: 'o3', status: 'LOCKED' }])

    // ровно 4 апдейта, и НИ один не трогал o3
    expect(mockPrisma.order.update).toHaveBeenCalledTimes(4)
    const updatedIds = mockPrisma.order.update.mock.calls.map((c) => c[0].where.id)
    expect(updatedIds).toEqual(['o1', 'o2', 'o4', 'o5'])
    expect(updatedIds).not.toContain('o3')

    // заявка → CANCELLED
    const subUpdate = mockPrisma.weeklyOrderSubmission.update.mock.calls.at(-1)![0]
    expect(subUpdate.data.status).toBe('CANCELLED')
  })
})
