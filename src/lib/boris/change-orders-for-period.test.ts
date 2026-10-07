import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Борис: «с 7 по 14 +1 обед» одним вызовом change_orders_for_period → план
 * «было → стало» с кнопкой; executor применяет строки с проверкой, что заказ
 * не меняли после плана.
 */

const { mockPrisma, mockPlan, mockApplyLine } = vi.hoisted(() => ({
  mockPrisma: {
    client: { findUnique: vi.fn() },
    clientLocation: { findUnique: vi.fn() },
    borisPendingAction: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  mockPlan: vi.fn(),
  mockApplyLine: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('./metrics/track', () => ({ trackBorisCall: vi.fn(async () => {}) }))
vi.mock('@/lib/orders/range-change', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orders/range-change')>('@/lib/orders/range-change')
  return { ...actual, planRangeChange: mockPlan, applyRangeLine: mockApplyLine }
})

import { BORIS_TOOLS } from './tools'
import { executePendingAction } from './executor'

const tool = BORIS_TOOLS.find((t) => t.name === 'change_orders_for_period')!

const LINE = (d: string, expected = 34, next = 35) => ({
  orderId: `o_${d}`,
  date: `2026-10-${d}`,
  locationId: 'loc_1',
  locationName: 'Склад',
  mealType: 'LUNCH',
  expected,
  next,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.client.findUnique.mockResolvedValue({ name: 'ИНПАРТ АВТО' })
  mockPrisma.clientLocation.findUnique.mockResolvedValue({ clientId: 'c1' })
})

describe('change_orders_for_period', () => {
  it('«с 8 по 14 +1 обед» → пачка строк с «было → стало», превью понятное', async () => {
    mockPlan.mockResolvedValue({ lines: [LINE('08'), LINE('09')], skipped: [], missingDates: ['2026-10-10'] })

    const r = (await tool.execute({
      clientId: 'c1',
      dateFrom: '2026-10-08',
      dateTo: '2026-10-14',
      mealTypes: ['LUNCH'],
      mode: 'add',
      portions: 1,
    })) as { pending: true; actions: Array<{ tool: string; input: Record<string, unknown> }>; preview: string }

    expect(mockPlan.mock.calls[0][0]).toEqual({
      clientId: 'c1',
      locationId: null,
      mealTypes: ['LUNCH'],
      dateFrom: '2026-10-08',
      dateTo: '2026-10-14',
      mode: 'add',
      portions: 1,
      weekdays: null,
    })
    expect(r.actions).toEqual([
      { tool: 'apply_range_line', input: { orderId: 'o_08', expected: 34, next: 35, label: 'чт 8 окт, обед' } },
      { tool: 'apply_range_line', input: { orderId: 'o_09', expected: 34, next: 35, label: 'пт 9 окт, обед' } },
    ])
    expect(r.preview).toBe(
      'ИНПАРТ АВТО: +1\n• чт 8 окт, обед — 34 → 35\n• пт 9 окт, обед — 34 → 35\nЗаказов нет: сб 10 окт',
    )
  })

  it('менять нечего → ошибка с причинами, без плана', async () => {
    mockPlan.mockResolvedValue({
      lines: [],
      skipped: [{ date: '2026-10-08', locationName: 'Склад', mealType: 'LUNCH', reason: 'приём на эту дату уже закрыт' }],
      missingDates: [],
    })
    const r = await tool.execute({ clientId: 'c1', dateFrom: '2026-10-08', dateTo: '2026-10-08', mode: 'add', portions: 1 })
    expect(r).toMatchObject({ ok: false, error: 'Менять нечего' })
  })

  it('невалидный период и чужая точка → ошибка до плана', async () => {
    expect(await tool.execute({ clientId: 'c1', dateFrom: '2026-10-14', dateTo: '2026-10-08', mode: 'add', portions: 1 })).toEqual({
      ok: false,
      error: 'Конец периода раньше начала',
    })
    mockPrisma.clientLocation.findUnique.mockResolvedValue({ clientId: 'other' })
    expect(
      await tool.execute({ clientId: 'c1', locationId: 'x', dateFrom: '2026-10-08', dateTo: '2026-10-09', mode: 'set', portions: 30 }),
    ).toEqual({ ok: false, error: 'location_not_found' })
    expect(mockPlan).not.toHaveBeenCalled()
  })
})

describe('executor — apply_range_line', () => {
  it('применяет каждую строку; заказ поменяли после плана — видно в итоге', async () => {
    mockPrisma.borisPendingAction.findUnique.mockResolvedValue({
      id: 'pa_1',
      conversationId: 'conv_1',
      conversation: { userId: 'u1' },
      expiresAt: new Date(Date.now() + 60_000),
      actions: [
        { tool: 'apply_range_line', input: { orderId: 'o_08', expected: 34, next: 35, label: 'чт 8 окт, обед' } },
        { tool: 'apply_range_line', input: { orderId: 'o_09', expected: 34, next: 35, label: 'пт 9 окт, обед' } },
      ],
    })
    mockPrisma.borisPendingAction.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', role: 'ADMIN_PRO' })
    mockApplyLine
      .mockResolvedValueOnce({ ok: true, note: null })
      .mockResolvedValueOnce({ ok: false, note: 'заказ изменился, сейчас 40' })

    const r = await executePendingAction('pa_1', 'u1')

    expect(mockApplyLine).toHaveBeenNthCalledWith(
      1,
      { id: 'u1', role: 'ADMIN_PRO' },
      { orderId: 'o_08', expected: 34, next: 35 },
      'boris_range',
    )
    expect(r.results).toEqual([
      { tool: 'apply_range_line', ok: true, error: undefined, data: { label: 'чт 8 окт, обед — 34 → 35' } },
      {
        tool: 'apply_range_line',
        ok: false,
        error: 'пт 9 окт, обед — 34 → 35: заказ изменился, сейчас 40',
        data: undefined,
      },
    ])
  })
})
