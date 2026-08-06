import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockAlreadyRanToday,
  mockGetOrders,
  mockMarkRanToday,
  mockNotifyProduction,
} = vi.hoisted(() => ({
  mockAlreadyRanToday: vi.fn(),
  mockGetOrders: vi.fn(),
  mockMarkRanToday: vi.fn(),
  mockNotifyProduction: vi.fn(),
}))

vi.mock('@/lib/orders/courier-queries', () => ({
  getCourierAssignmentOrders: mockGetOrders,
}))
vi.mock('@/lib/bot/daily-summary', () => ({
  alreadyRanToday: mockAlreadyRanToday,
  markRanToday: mockMarkRanToday,
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
  ranToday = false
  mockAlreadyRanToday.mockImplementation(async () => ranToday)
  mockMarkRanToday.mockImplementation(async () => {
    ranToday = true
  })
  mockGetOrders.mockResolvedValue([order()])
  mockNotifyProduction.mockResolvedValue({ ok: true, destination: 'production' })
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
    expect(mockMarkRanToday).not.toHaveBeenCalled()
  })

  it('не маскирует Telegram failure как success и не ставит marker', async () => {
    mockNotifyProduction.mockResolvedValue({
      ok: false,
      destination: null,
      error: 'telegram unavailable',
    })

    await expect(handler(REQUEST)).rejects.toThrow('telegram unavailable')
    expect(mockMarkRanToday).not.toHaveBeenCalled()
  })

  it('повторный штатный handler не отправляет второй идентичный пост', async () => {
    const first = await handler(REQUEST)
    const second = await handler(REQUEST)

    expect((await first.json()).ok).toBe(true)
    expect(await second.json()).toEqual({ ok: true, skipped: 'already_ran_today' })
    expect(mockNotifyProduction).toHaveBeenCalledOnce()
    expect(mockMarkRanToday).toHaveBeenCalledOnce()
  })

  it('ошибка записи idempotency marker после send не выдаёт ложный success', async () => {
    mockMarkRanToday.mockResolvedValue(undefined)
    mockAlreadyRanToday.mockResolvedValue(false)

    await expect(handler(REQUEST)).rejects.toThrow('marker')
    expect(mockNotifyProduction).toHaveBeenCalledOnce()
  })
})
