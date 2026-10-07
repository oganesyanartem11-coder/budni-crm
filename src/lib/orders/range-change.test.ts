import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Изменение заказов на период («с 7 по 14 +1 обед»): план по существующим
 * заказам и применение с проверкой «заказ не меняли после плана».
 */

const { mockPrisma, mockSetPortions } = vi.hoisted(() => ({
  mockPrisma: { order: { findMany: vi.fn(), findUnique: vi.fn() } },
  mockSetPortions: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/orders/client-portions', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orders/client-portions')>('@/lib/orders/client-portions')
  return { ...actual, setOrderPortionsForClient: mockSetPortions }
})

import { applyRangeLine, formatRangePlanLines, planRangeChange, validateRangeRequest } from './range-change'

// ср 7 окт 2026, 12:00 МСК: на чт 8 окт приём ещё открыт (до 16:00).
const NOW = new Date('2026-10-07T09:00:00.000Z')
const LOC = { name: 'Склад', sameDayDelivery: false, isActive: true, cutoffHourMsk: null, cutoffMinuteMsk: null }
const ACTOR = { id: 'u1', role: 'ADMIN_PRO' as const }

function order(day: string, portions: number, extra: Record<string, unknown> = {}) {
  return {
    id: `o_${day}`,
    deliveryDate: new Date(`2026-10-${day}T00:00:00.000Z`),
    mealType: 'LUNCH',
    portions,
    status: 'CONFIRMED',
    locationId: 'loc_1',
    updDocumentLink: null,
    location: LOC,
    ...extra,
  }
}

const REQ = {
  clientId: 'c1',
  locationId: 'loc_1',
  mealTypes: ['LUNCH' as const],
  dateFrom: '2026-10-07',
  dateTo: '2026-10-14',
  mode: 'add' as const,
  portions: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('planRangeChange', () => {
  it('«с 7 по 14 +1 обед»: 34 → 35 по каждому заказу, 7-е закрыто, выходные без заказов', async () => {
    mockPrisma.order.findMany.mockResolvedValue(
      ['07', '08', '09', '12', '13', '14'].map((d) => order(d, 34)),
    )

    const plan = await planRangeChange(REQ, NOW)

    expect(plan.lines.map((l) => [l.date, l.expected, l.next])).toEqual([
      ['2026-10-08', 34, 35],
      ['2026-10-09', 34, 35],
      ['2026-10-12', 34, 35],
      ['2026-10-13', 34, 35],
      ['2026-10-14', 34, 35],
    ])
    expect(plan.skipped).toEqual([
      { date: '2026-10-07', locationName: 'Склад', mealType: 'LUNCH', reason: 'приём на эту дату уже закрыт' },
    ])
    expect(plan.missingDates).toEqual(['2026-10-10', '2026-10-11'])
    expect(mockPrisma.order.findMany.mock.calls[0][0].where).toMatchObject({
      clientId: 'c1',
      locationId: 'loc_1',
      mealType: { in: ['LUNCH'] },
      status: { not: 'CANCELLED' },
      deliveryDate: { gte: new Date('2026-10-07T00:00:00.000Z'), lte: new Date('2026-10-14T00:00:00.000Z') },
    })
    expect(formatRangePlanLines(plan)).toEqual([
      '• чт 8 окт, обед — 34 → 35',
      '• пт 9 окт, обед — 34 → 35',
      '• пн 12 окт, обед — 34 → 35',
      '• вт 13 окт, обед — 34 → 35',
      '• ср 14 окт, обед — 34 → 35',
      'Не изменится:',
      '• ср 7 окт, обед — приём на эту дату уже закрыт',
      'Заказов нет: сб 10 окт, вс 11 окт',
    ])
  })

  it('«по 30» (set): PENDING без ответа подтверждается числом; уже 30 — без изменений', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      order('08', 0, { status: 'PENDING_CONFIRMATION' }),
      order('09', 30),
      order('12', 25),
    ])
    const plan = await planRangeChange({ ...REQ, mode: 'set', portions: 30 }, NOW)
    expect(plan.lines.map((l) => [l.date, l.expected, l.next])).toEqual([
      ['2026-10-08', 0, 30],
      ['2026-10-12', 25, 30],
    ])
    expect(plan.skipped.map((s) => s.reason)).toEqual(['уже 30'])
  })

  it('пропуски: в работе, УПД, без ответа при +N, уход в минус', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      order('08', 34, { status: 'IN_PRODUCTION' }),
      order('09', 34, { updDocumentLink: { id: 'u' } }),
      order('12', 0, { status: 'PENDING_CONFIRMATION' }),
      order('13', 1),
    ])
    const plan = await planRangeChange({ ...REQ, portions: -2 }, NOW)
    expect(plan.lines).toEqual([])
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'уже в работе у кухни',
      'по заказу выписан УПД',
      'клиент ещё не назвал число — не к чему прибавить',
      'в заказе 1, убрать 2 нельзя',
    ])
  })

  it('weekdays: только будни', async () => {
    mockPrisma.order.findMany.mockResolvedValue([order('09', 34), order('10', 34), order('12', 34)])
    const plan = await planRangeChange({ ...REQ, weekdays: [1, 2, 3, 4, 5] }, NOW)
    expect(plan.lines.map((l) => l.date)).toEqual(['2026-10-09', '2026-10-12'])
    expect(plan.missingDates).not.toContain('2026-10-10')
  })
})

describe('validateRangeRequest', () => {
  it('ловит перевёрнутый, длинный период и нулевое изменение', () => {
    expect(validateRangeRequest(REQ)).toBeNull()
    expect(validateRangeRequest({ ...REQ, dateTo: '2026-10-01' })).toBe('Конец периода раньше начала')
    expect(validateRangeRequest({ ...REQ, dateTo: '2026-12-01' })).toMatch(/длиннее/)
    expect(validateRangeRequest({ ...REQ, portions: 0 })).toBe('Непонятное количество')
  })
})

describe('applyRangeLine', () => {
  const LINE = { orderId: 'o_08', expected: 34, next: 35 }
  const current = (portions: number, status = 'CONFIRMED') => ({
    portions,
    status,
    deliveryDate: new Date('2026-10-08T00:00:00.000Z'),
    location: LOC,
  })

  it('заказ как в плане → ставим 35 общим путём', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(current(34))
    mockSetPortions.mockResolvedValue({ ok: true, kind: 'updated', orderId: 'o_08', prevPortions: 34, prevStatus: 'CONFIRMED' })
    expect(await applyRangeLine(ACTOR, LINE, 'range_change', NOW)).toEqual({ ok: true, note: null })
    expect(mockSetPortions).toHaveBeenCalledWith(ACTOR, { orderId: 'o_08', portions: 35, via: 'range_change' })
  })

  it('второе нажатие: уже 35 → ничего не прибавляем', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(current(35))
    expect(await applyRangeLine(ACTOR, LINE, 'range_change', NOW)).toEqual({ ok: true, note: 'уже стоит' })
    expect(mockSetPortions).not.toHaveBeenCalled()
  })

  it('заказ поменяли после плана → пропуск с причиной', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(current(40))
    expect(await applyRangeLine(ACTOR, LINE, 'range_change', NOW)).toEqual({
      ok: false,
      note: 'заказ изменился, сейчас 40',
    })
    expect(mockSetPortions).not.toHaveBeenCalled()
  })

  it('пока ждали подтверждения, прошёл cut-off → не меняем', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(current(34))
    const late = new Date('2026-10-07T14:00:00.000Z') // ср 17:00 МСК
    expect(await applyRangeLine(ACTOR, LINE, 'range_change', late)).toEqual({
      ok: false,
      note: 'приём на эту дату уже закрыт',
    })
  })
})
