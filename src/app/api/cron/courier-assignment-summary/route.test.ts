import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockAlreadyRanToday,
  mockAcquireClaim,
  mockCompleteClaim,
  mockFailClaim,
  mockGetOrders,
  mockMarkPartSent,
  mockMarkRanToday,
  mockNotifyProduction,
  mockResumeClaim,
} = vi.hoisted(() => ({
  mockAlreadyRanToday: vi.fn(),
  mockAcquireClaim: vi.fn(),
  mockCompleteClaim: vi.fn(),
  mockFailClaim: vi.fn(),
  mockGetOrders: vi.fn(),
  mockMarkPartSent: vi.fn(),
  mockMarkRanToday: vi.fn(),
  mockNotifyProduction: vi.fn(),
  mockResumeClaim: vi.fn(),
}))

vi.mock('@/lib/orders/courier-queries', () => ({
  getCourierAssignmentOrders: mockGetOrders,
}))
vi.mock('@/lib/bot/daily-summary', () => ({
  alreadyRanToday: mockAlreadyRanToday,
  markRanToday: mockMarkRanToday,
}))
vi.mock('@/lib/cron/multipart-delivery-claim', () => ({
  acquireMultipartDeliveryClaim: mockAcquireClaim,
  completeMultipartDeliveryClaim: mockCompleteClaim,
  failMultipartDeliveryClaim: mockFailClaim,
  markMultipartDeliveryPartSent: mockMarkPartSent,
  resumeMultipartDeliveryClaim: mockResumeClaim,
}))
vi.mock('@/lib/telegram/notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/telegram/notify')>()
  return { ...actual, notifyProductionChannel: mockNotifyProduction }
})

import { handler } from './route'
import type { CourierAssignmentOrder } from '@/lib/orders/courier-queries'

const REQUEST = new Request('http://x/api/cron/courier-assignment-summary')

function order(over: Partial<CourierAssignmentOrder> = {}): CourierAssignmentOrder {
  return {
    orderId: 'order_1',
    clientId: 'client_1',
    clientName: 'Клиент',
    clientContactName: 'Контакт',
    clientContactPhone: '+70000000000',
    locationId: 'loc_1',
    locationName: 'Точка',
    locationAddress: 'Адрес',
    deliveryWindowFrom: '09:00',
    deliveryWindowTo: '10:00',
    mealType: 'LUNCH',
    portions: 10,
    status: 'CONFIRMED',
    assignedCourierId: 'courier_1',
    assignedCourier: { id: 'courier_1', name: 'Курьер' },
    assignmentMode: 'IN_HOUSE',
    courierLabel: 'Курьер',
    packaging: 'INDIVIDUAL',
    tags: [],
    notes: null,
    ...over,
  }
}

let ranToday = false

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-11T15:10:00.000Z'))
  ranToday = false
  mockAlreadyRanToday.mockImplementation(async () => ranToday)
  mockMarkRanToday.mockImplementation(async () => {
    ranToday = true
  })
  mockGetOrders.mockResolvedValue([order()])
  mockNotifyProduction.mockResolvedValue({ ok: true, destination: 'production' })
  mockAcquireClaim.mockImplementation(async (key: string, messages: string[]) => ({
    status: 'acquired',
    key,
    token: 'claim-token',
    messages,
    nextPartIndex: 0,
    rawValue: 'claim-0',
  }))
  mockMarkPartSent.mockImplementation(async (claim, partIndex: number) => ({
    ...claim,
    nextPartIndex: partIndex + 1,
    rawValue: `claim-${partIndex + 1}`,
  }))
  mockCompleteClaim.mockResolvedValue(undefined)
  mockFailClaim.mockResolvedValue(undefined)
  mockResumeClaim.mockResolvedValue({ status: 'no_claim' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('courier-assignment-summary handler', () => {
  it('в 00:30 МСК передаёт query UTC-полночь правильного завтра', async () => {
    vi.setSystemTime(new Date('2026-08-05T21:30:00.000Z'))

    const response = await handler(REQUEST)
    const body = await response.json()

    expect(mockGetOrders).toHaveBeenCalledWith(new Date('2026-08-07T00:00:00.000Z'))
    expect(mockNotifyProduction).toHaveBeenCalledWith(
      expect.stringContaining('🚚 Курьеры на завтра — 07.08.2026'),
      { parseMode: 'HTML' },
    )
    expect(mockAcquireClaim).toHaveBeenCalledWith(
      'courier-assignment-summary:2026-08-07',
      [expect.stringContaining('🚚 Курьеры на завтра — 07.08.2026')],
    )
    expect(mockMarkPartSent).toHaveBeenCalledOnce()
    expect(mockCompleteClaim).toHaveBeenCalledOnce()
    expect(mockMarkRanToday).toHaveBeenCalledWith(
      'courier-assignment-summary',
      expect.objectContaining({
        deliveryDate: '2026-08-07',
        couriers: 1,
        stops: 1,
        orders: 1,
        unassigned: 0,
      }),
    )
    expect(body).toEqual(expect.objectContaining({
      ok: true,
      couriers: 1,
      stops: 1,
      orders: 1,
      unassigned: 0,
    }))
  })

  it('пустой день не отправляет и возвращает skipped=no_orders', async () => {
    mockGetOrders.mockResolvedValue([])

    const response = await handler(REQUEST)

    expect(await response.json()).toEqual({ ok: true, skipped: 'no_orders' })
    expect(mockNotifyProduction).not.toHaveBeenCalled()
    expect(mockAcquireClaim).not.toHaveBeenCalled()
    expect(mockResumeClaim).toHaveBeenCalledWith(
      'courier-assignment-summary:2026-08-12',
    )
    expect(mockMarkRanToday).not.toHaveBeenCalled()
  })

  it('counts only unique UNASSIGNED stops, not InDrive orders', async () => {
    mockGetOrders.mockResolvedValue([
      order({
        orderId: 'external-lunch',
        locationId: 'external-location',
        assignedCourierId: null,
        assignedCourier: null,
        assignmentMode: 'EXTERNAL',
        courierLabel: 'InDrive',
      }),
      order({
        orderId: 'external-dinner',
        locationId: 'external-location',
        mealType: 'DINNER',
        assignedCourierId: null,
        assignedCourier: null,
        assignmentMode: 'EXTERNAL',
        courierLabel: 'InDrive',
      }),
      order({
        orderId: 'unassigned-lunch',
        locationId: 'unassigned-location',
        assignedCourierId: null,
        assignedCourier: null,
        assignmentMode: 'UNASSIGNED',
        courierLabel: 'Не назначено',
      }),
      order({
        orderId: 'unassigned-dinner',
        locationId: 'unassigned-location',
        mealType: 'DINNER',
        assignedCourierId: null,
        assignedCourier: null,
        assignmentMode: 'UNASSIGNED',
        courierLabel: 'Не назначено',
      }),
    ])

    const response = await handler(REQUEST)

    expect(await response.json()).toEqual(expect.objectContaining({
      stops: 2,
      unassigned: 1,
    }))
  })

  it('не маскирует Telegram failure как success и не ставит marker', async () => {
    mockNotifyProduction.mockResolvedValue({
      ok: false,
      destination: null,
      error: 'telegram unavailable',
    })

    await expect(handler(REQUEST)).rejects.toThrow('telegram unavailable')
    expect(mockFailClaim).toHaveBeenCalledWith(
      expect.objectContaining({ nextPartIndex: 0 }),
      expect.stringContaining('telegram unavailable'),
    )
    expect(mockCompleteClaim).not.toHaveBeenCalled()
    expect(mockMarkRanToday).not.toHaveBeenCalled()
  })

  it('повторный штатный handler не отправляет второй идентичный пост', async () => {
    const first = await handler(REQUEST)
    const second = await handler(REQUEST)

    expect((await first.json()).ok).toBe(true)
    expect(await second.json()).toEqual({ ok: true, skipped: 'already_ran_today' })
    expect(mockNotifyProduction).toHaveBeenCalledOnce()
    expect(mockAcquireClaim).toHaveBeenCalledOnce()
    expect(mockMarkRanToday).toHaveBeenCalledOnce()
  })

  it('ошибка ActivityLog после durable SENT не превращает доставку в failure', async () => {
    mockMarkRanToday.mockRejectedValue(new Error('activity log unavailable'))

    const response = await handler(REQUEST)

    expect((await response.json()).ok).toBe(true)
    expect(mockNotifyProduction).toHaveBeenCalledOnce()
    expect(mockCompleteClaim).toHaveBeenCalledOnce()
  })

  it('параллельный свежий claim останавливает runner до Telegram side effect', async () => {
    mockAcquireClaim.mockResolvedValue({ status: 'in_progress' })

    const response = await handler(REQUEST)

    expect(await response.json()).toEqual({
      ok: true,
      skipped: 'delivery_in_progress',
    })
    expect(mockNotifyProduction).not.toHaveBeenCalled()
    expect(mockMarkPartSent).not.toHaveBeenCalled()
    expect(mockCompleteClaim).not.toHaveBeenCalled()
    expect(mockMarkRanToday).not.toHaveBeenCalled()
  })

  it('durable SENT claim не отправляет сводку повторно без ActivityLog', async () => {
    mockAcquireClaim.mockResolvedValue({ status: 'already_sent' })

    const response = await handler(REQUEST)

    expect(await response.json()).toEqual({
      ok: true,
      skipped: 'already_delivered',
    })
    expect(mockNotifyProduction).not.toHaveBeenCalled()
  })

  it('возобновляет failed multipart с первой неотправленной сохранённой части', async () => {
    mockAcquireClaim.mockResolvedValue({
      status: 'acquired',
      key: 'courier-assignment-summary:2026-08-07',
      token: 'resumed-token',
      messages: ['сохранённая часть 1', 'сохранённая часть 2'],
      nextPartIndex: 1,
      rawValue: 'resumed-1',
    })

    const response = await handler(REQUEST)

    expect((await response.json()).ok).toBe(true)
    expect(mockNotifyProduction).toHaveBeenCalledOnce()
    expect(mockNotifyProduction).toHaveBeenCalledWith(
      'сохранённая часть 2',
      { parseMode: 'HTML' },
    )
    expect(mockMarkPartSent).toHaveBeenCalledWith(
      expect.objectContaining({ nextPartIndex: 1 }),
      1,
    )
    expect(mockCompleteClaim).toHaveBeenCalledWith(
      expect.objectContaining({ nextPartIndex: 2 }),
    )
  })

  it('фиксирует прогресс после каждой успешно отправленной части', async () => {
    mockAcquireClaim.mockResolvedValue({
      status: 'acquired',
      key: 'courier-assignment-summary:2026-08-07',
      token: 'multipart-token',
      messages: ['часть 1', 'часть 2'],
      nextPartIndex: 0,
      rawValue: 'multipart-0',
    })

    await handler(REQUEST)

    expect(mockNotifyProduction).toHaveBeenCalledTimes(2)
    expect(mockMarkPartSent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ nextPartIndex: 0 }),
      0,
    )
    expect(mockMarkPartSent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ nextPartIndex: 1 }),
      1,
    )
    expect(mockCompleteClaim).toHaveBeenCalledWith(
      expect.objectContaining({ nextPartIndex: 2 }),
    )
  })

  it('досылает durable failed multipart, даже если текущая выборка заказов пуста', async () => {
    mockGetOrders.mockResolvedValue([])
    mockResumeClaim.mockResolvedValue({
      status: 'acquired',
      key: 'courier-assignment-summary:2026-08-12',
      token: 'empty-query-resume',
      messages: ['уже сохранённая часть 1', 'уже сохранённая часть 2'],
      nextPartIndex: 1,
      rawValue: 'empty-query-1',
    })

    const response = await handler(REQUEST)

    expect((await response.json()).ok).toBe(true)
    expect(mockNotifyProduction).toHaveBeenCalledOnce()
    expect(mockNotifyProduction).toHaveBeenCalledWith(
      'уже сохранённая часть 2',
      { parseMode: 'HTML' },
    )
    expect(mockCompleteClaim).toHaveBeenCalledWith(
      expect.objectContaining({ nextPartIndex: 2 }),
    )
  })
})
