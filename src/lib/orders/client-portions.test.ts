import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const { mockPrisma, mockCore } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    activityLog: { create: vi.fn() },
    user: { findFirst: vi.fn() },
  },
  mockCore: {
    cancelOrderCore: vi.fn(),
    createOneTimeOrderCore: vi.fn(),
    editOrderPortionsCore: vi.fn(),
  },
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/app/(app)/orders/actions', () => mockCore)

import {
  applyPortionsByBusinessKey,
  firstEditableDeliveryDate,
  isDeliveryDateEditable,
  setOrderPortionsForClient,
} from './client-portions'

const ACTOR = { id: 'admin_pro_1', role: 'ADMIN_PRO' as const }
const DAY = new Date('2026-10-06T00:00:00.000Z')

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'order_1',
    status: 'CONFIRMED',
    portions: 30,
    pricePerPortion: new Prisma.Decimal(300),
    updDocumentLink: null,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCore.cancelOrderCore.mockResolvedValue({ ok: true, data: undefined })
  mockCore.editOrderPortionsCore.mockResolvedValue({ ok: true, data: { editedAfterLock: false } })
  mockCore.createOneTimeOrderCore.mockResolvedValue({ ok: true, data: { orderId: 'order_new' } })
  mockPrisma.order.update.mockResolvedValue({})
  mockPrisma.activityLog.create.mockResolvedValue({})
})

describe('setOrderPortionsForClient', () => {
  it('CONFIRMED → editOrderPortionsCore с новым числом', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(order())
    const r = await setOrderPortionsForClient(ACTOR, { orderId: 'order_1', portions: 33, via: 'test' })
    expect(r).toEqual({ ok: true, kind: 'updated', orderId: 'order_1', prevPortions: 30, prevStatus: 'CONFIRMED' })
    expect(mockCore.editOrderPortionsCore).toHaveBeenCalledWith(ACTOR, { orderId: 'order_1', portions: 33 })
  })

  it('то же число → unchanged, Core не зовётся', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(order())
    const r = await setOrderPortionsForClient(ACTOR, { orderId: 'order_1', portions: 30, via: 'test' })
    expect(r).toMatchObject({ ok: true, kind: 'unchanged' })
    expect(mockCore.editOrderPortionsCore).not.toHaveBeenCalled()
  })

  it('PENDING_CONFIRMATION (DYNAMIC, 0 порций) → CONFIRMED с числом и totalPrice', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(order({ status: 'PENDING_CONFIRMATION', portions: 0 }))
    const r = await setOrderPortionsForClient(ACTOR, { orderId: 'order_1', portions: 25, via: 'test' })
    expect(r).toMatchObject({ ok: true, kind: 'confirmed', prevPortions: 0, prevStatus: 'PENDING_CONFIRMATION' })
    const data = mockPrisma.order.update.mock.calls[0][0].data
    expect(data.status).toBe('CONFIRMED')
    expect(data.portions).toBe(25)
    expect(Number(data.totalPrice)).toBe(7500)
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'ORDER_CONFIRMED', userId: 'admin_pro_1' }) }),
    )
  })

  it('0 → отмена через cancelOrderCore', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(order())
    const r = await setOrderPortionsForClient(ACTOR, { orderId: 'order_1', portions: 0, via: 'weekly' })
    expect(r).toMatchObject({ ok: true, kind: 'cancelled', prevPortions: 30 })
    expect(mockCore.cancelOrderCore).toHaveBeenCalledWith(ACTOR, { orderId: 'order_1', reason: 'weekly' })
  })

  it('заказ с УПД не трогаем — пропуск с причиной', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(order({ updDocumentLink: { id: 'upd_1' } }))
    const r = await setOrderPortionsForClient(ACTOR, { orderId: 'order_1', portions: 33, via: 'test' })
    expect(r).toEqual({ ok: false, skipped: true, reason: 'по заказу уже выписан УПД', orderId: 'order_1' })
    expect(mockCore.editOrderPortionsCore).not.toHaveBeenCalled()
    expect(mockPrisma.order.update).not.toHaveBeenCalled()
  })

  it('заказ в работе (LOCKED) — пропуск', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(order({ status: 'LOCKED' }))
    const r = await setOrderPortionsForClient(ACTOR, { orderId: 'order_1', portions: 33, via: 'test' })
    expect(r).toMatchObject({ ok: false, skipped: true })
  })

  it('ошибка Core не глотается', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(order())
    mockCore.editOrderPortionsCore.mockResolvedValue({ ok: false, error: 'Данные устарели' })
    const r = await setOrderPortionsForClient(ACTOR, { orderId: 'order_1', portions: 33, via: 'test' })
    expect(r).toEqual({ ok: false, skipped: false, error: 'Данные устарели', orderId: 'order_1' })
  })
})

describe('applyPortionsByBusinessKey', () => {
  const key = {
    clientId: 'client_1',
    locationId: 'loc_1',
    mealType: 'LUNCH' as const,
    deliveryDate: DAY,
    source: 'WEEKLY_AUTO' as const,
    via: 'weekly',
  }

  it('нет заказа → createOneTimeOrderCore (тихо) + привязка к заявке', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null)
    const r = await applyPortionsByBusinessKey(ACTOR, { ...key, portions: 30, weeklySubmissionId: 'sub_1' })
    expect(r).toMatchObject({ ok: true, kind: 'created', orderId: 'order_new' })
    expect(mockCore.createOneTimeOrderCore).toHaveBeenCalledWith(ACTOR, {
      clientId: 'client_1',
      locationId: 'loc_1',
      mealType: 'LUNCH',
      deliveryDate: DAY,
      portions: 30,
      source: 'WEEKLY_AUTO',
      silent: true,
    })
    expect(mockPrisma.order.update).toHaveBeenCalledWith({
      where: { id: 'order_new' },
      data: { weeklySubmissionId: 'sub_1' },
    })
  })

  it('есть FIXED-заказ на ту же дату → обновление, без create (нет P2002)', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'order_fixed' })
    mockPrisma.order.findUnique.mockResolvedValue(order({ id: 'order_fixed' }))
    const r = await applyPortionsByBusinessKey(ACTOR, { ...key, portions: 35 })
    expect(r).toMatchObject({ ok: true, kind: 'updated', orderId: 'order_fixed' })
    expect(mockCore.createOneTimeOrderCore).not.toHaveBeenCalled()
    expect(mockPrisma.order.findFirst).toHaveBeenCalledWith({
      where: {
        clientId: 'client_1',
        locationId: 'loc_1',
        mealType: 'LUNCH',
        deliveryDate: DAY,
        status: { not: 'CANCELLED' },
      },
      select: { id: true },
    })
  })

  it('0 без заказа → noop', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null)
    const r = await applyPortionsByBusinessKey(ACTOR, { ...key, portions: 0 })
    expect(r).toMatchObject({ ok: true, kind: 'noop', orderId: null })
    expect(mockCore.createOneTimeOrderCore).not.toHaveBeenCalled()
  })
})

describe('редактируемость даты по cut-off', () => {
  const regular = { sameDayDelivery: false, isActive: true, cutoffHourMsk: null, cutoffMinuteMsk: null }

  it('обычная точка: до 16:00 МСК — завтра, после — послезавтра', () => {
    const morning = new Date('2026-10-01T09:00:00.000Z') // чт 12:00 МСК
    const evening = new Date('2026-10-01T13:00:00.000Z') // чт 16:00 МСК
    expect(firstEditableDeliveryDate(regular, morning)).toEqual(new Date('2026-10-02T00:00:00.000Z'))
    expect(firstEditableDeliveryDate(regular, evening)).toEqual(new Date('2026-10-03T00:00:00.000Z'))
  })

  it('около полуночи МСК (UTC ещё «вчера») день считается по МСК', () => {
    const nearMidnight = new Date('2026-10-01T21:30:00.000Z') // пт 00:30 МСК
    expect(firstEditableDeliveryDate(regular, nearMidnight)).toEqual(new Date('2026-10-03T00:00:00.000Z'))
  })

  it('same-day точка: сегодня до её cut-off', () => {
    const sameDay = { sameDayDelivery: true, isActive: true, cutoffHourMsk: 8, cutoffMinuteMsk: 40 }
    const early = new Date('2026-10-01T05:00:00.000Z') // 08:00 МСК
    expect(isDeliveryDateEditable(sameDay, new Date('2026-10-01T00:00:00.000Z'), early)).toBe(true)
    const late = new Date('2026-10-01T06:00:00.000Z') // 09:00 МСК
    expect(isDeliveryDateEditable(sameDay, new Date('2026-10-01T00:00:00.000Z'), late)).toBe(false)
  })
})
