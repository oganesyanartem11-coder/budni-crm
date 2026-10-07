import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPrisma, mockPlan, mockApply } = vi.hoisted(() => ({
  mockPrisma: { activityLog: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() } },
  mockPlan: vi.fn(),
  mockApply: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/bot/max-users', () => ({ getActiveMaxChatIdForClient: vi.fn(async () => 'max_active') }))
vi.mock('@/lib/orders/range-change', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orders/range-change')>('@/lib/orders/range-change')
  return { ...actual, planRangeChange: mockPlan, applyRangeLine: mockApply }
})

import {
  confirmRangeRequest,
  formatRangeRequestText,
  rejectRangeRequest,
  submitClientRangeRequest,
  RANGE_REQUESTED_ACTION,
} from './range-request'

const REQUEST = {
  clientId: 'c1',
  locationId: 'loc_1',
  mealTypes: ['LUNCH' as const],
  dateFrom: '2026-10-08',
  dateTo: '2026-10-14',
  mode: 'add' as const,
  portions: 1,
}
const LINE = (d: string) => ({
  orderId: `o_${d}`,
  date: `2026-10-${d}`,
  locationId: 'loc_1',
  locationName: 'Склад',
  mealType: 'LUNCH' as const,
  expected: 34,
  next: 35,
})
const PLAN = { lines: [LINE('08'), LINE('09')], skipped: [], missingDates: ['2026-10-10', '2026-10-11'] }
const ACTOR = { id: 'u1', role: 'ADMIN_PRO' as const }

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.activityLog.create.mockResolvedValue({ id: 'req_1' })
  mockPrisma.activityLog.findFirst.mockResolvedValue(null)
})

describe('запрос клиента на период', () => {
  it('есть что менять → запрос сохранён, сообщение менеджеру понятное', async () => {
    mockPlan.mockResolvedValue(PLAN)
    const r = await submitClientRangeRequest({
      clientId: 'c1',
      clientName: 'ИНПАРТ АВТО',
      rawText: 'С 8 по 14 добавьте 1 обед',
      sourceMaxChatId: 'max_1',
      request: REQUEST,
    })
    expect(r).toEqual({ kind: 'pending', requestId: 'req_1', plan: PLAN })
    expect(mockPrisma.activityLog.create.mock.calls[0][0].data).toMatchObject({
      action: RANGE_REQUESTED_ACTION,
      entityId: 'c1',
    })
    expect(
      formatRangeRequestText({
        clientName: 'ИНПАРТ АВТО',
        rawText: 'С 8 по 14 добавьте 1 обед',
        sourceMaxChatId: 'max_1',
        request: REQUEST,
        plan: PLAN,
      }),
    ).toBe(
      [
        '📩 ИНПАРТ АВТО: изменение на период',
        '💬 «С 8 по 14 добавьте 1 обед»',
        '',
        'чт 8 окт — ср 14 окт, +1. Если подтвердить:',
        '• чт 8 окт, обед — 34 → 35',
        '• пт 9 окт, обед — 34 → 35',
        'Заказов нет: сб 10 окт, вс 11 окт',
      ].join('\n'),
    )
  })

  it('менять нечего → причина, запрос не сохраняется', async () => {
    mockPlan.mockResolvedValue({
      lines: [],
      skipped: [{ date: '2026-10-08', locationName: 'Склад', mealType: 'LUNCH', reason: 'приём на эту дату уже закрыт' }],
      missingDates: [],
    })
    const r = await submitClientRangeRequest({
      clientId: 'c1',
      clientName: 'X',
      rawText: 't',
      sourceMaxChatId: 'm',
      request: REQUEST,
    })
    expect(r).toMatchObject({ kind: 'nothing', reason: 'приём на эту дату уже закрыт' })
    expect(mockPrisma.activityLog.create).not.toHaveBeenCalled()
  })

  const STORED = {
    id: 'req_1',
    action: RANGE_REQUESTED_ACTION,
    entityId: 'c1',
    payload: { clientName: 'ИНПАРТ АВТО', rawText: 't', sourceMaxChatId: 'max_1', request: REQUEST, plan: PLAN },
  }

  it('«Подтвердить» → строки применены, клиенту «Обновили: …», повтор — «уже обработано»', async () => {
    mockPrisma.activityLog.findUnique.mockResolvedValue(STORED)
    mockApply.mockResolvedValueOnce({ ok: true, note: null }).mockResolvedValueOnce({ ok: false, note: 'заказ изменился, сейчас 40' })

    const r = await confirmRangeRequest({ requestId: 'req_1', actor: ACTOR })

    expect(r).toEqual({
      ok: true,
      managerText: '✅ ИНПАРТ АВТО: изменено\n• чт 8 окт, обед — 35\nНе получилось:\n• пт 9 окт, обед — заказ изменился, сейчас 40',
      clientReply: 'Обновили: чт 8 окт, обед — 35. По остальным дням менеджер свяжется с вами.',
      clientChatId: 'max_active',
    })
    expect(mockApply).toHaveBeenCalledWith(ACTOR, LINE('08'), 'range_change', undefined)

    mockPrisma.activityLog.findFirst.mockResolvedValue({ id: 'resolved' })
    expect(await confirmRangeRequest({ requestId: 'req_1', actor: ACTOR })).toEqual({
      ok: false,
      reason: 'already_processed',
    })
  })

  it('«Отклонить» → заказы не трогаем', async () => {
    mockPrisma.activityLog.findUnique.mockResolvedValue(STORED)
    const r = await rejectRangeRequest({ requestId: 'req_1', actor: ACTOR })
    expect(r).toMatchObject({ ok: true, clientReply: 'Спасибо! Менеджер свяжется с вами по изменению.' })
    expect(mockApply).not.toHaveBeenCalled()
  })
})
