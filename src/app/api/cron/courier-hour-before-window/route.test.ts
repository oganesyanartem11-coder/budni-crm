import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * П5: тест «за час до окна». Мокаем courier-queries и notifyProductionChannel;
 * escapeHtml реальная. Ключевое: ИНДИВИДУАЛЬНЫЙ пуш на каждый заказ (N заказов
 * → N вызовов notifyProductionChannel) и пометка после каждого пуша.
 */

const { mockGetHour, mockMark, mockNotify } = vi.hoisted(() => ({
  mockGetHour: vi.fn(),
  mockMark: vi.fn(),
  mockNotify: vi.fn(),
}))

vi.mock('@/lib/orders/courier-queries', () => ({
  getOrdersForHourBeforeWindow: mockGetHour,
  markCourierNotified: mockMark,
}))
vi.mock('@/lib/telegram/notify', () => ({
  notifyProductionChannel: mockNotify,
  escapeHtml: (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}))

import { handler, buildHourBeforeText } from './route'
import type { OrderWithoutCourier } from '@/lib/orders/courier-queries'

const REQ = new Request('http://x/api/cron/courier-hour-before-window')

function order(over: Partial<OrderWithoutCourier> = {}): OrderWithoutCourier {
  return {
    orderId: 'o1',
    clientName: 'Кафе',
    clientContactPhone: '+7900',
    locationName: 'Точка',
    locationAddress: 'Ленина 1',
    deliveryWindowFrom: '12:00',
    deliveryWindowTo: '13:00',
    mealType: 'LUNCH',
    portions: 20,
    totalPrice: 10000,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockMark.mockResolvedValue(1)
  mockNotify.mockResolvedValue(undefined)
})

describe('courier-hour-before-window handler', () => {
  it('0 заказов → sent:0, без отправки/пометки', async () => {
    mockGetHour.mockResolvedValue([])

    const res = await handler(REQ)
    const body = await res.json()

    expect(body).toEqual({ ok: true, sent: 0 })
    expect(mockNotify).not.toHaveBeenCalled()
    expect(mockMark).not.toHaveBeenCalled()
  })

  it('N заказов → N индивидуальных пушей, каждый помечается своим id', async () => {
    mockGetHour.mockResolvedValue([
      order({ orderId: 'a' }),
      order({ orderId: 'b' }),
      order({ orderId: 'c' }),
    ])

    const res = await handler(REQ)
    const body = await res.json()

    expect(body).toEqual({ ok: true, sent: 3 })
    expect(mockNotify).toHaveBeenCalledTimes(3)
    // Каждый пуш с parseMode HTML.
    expect(mockNotify.mock.calls.every((c) => c[1]?.parseMode === 'HTML')).toBe(true)
    // Пометка по одному id за раз.
    expect(mockMark).toHaveBeenCalledTimes(3)
    expect(mockMark.mock.calls.map((c) => c[0])).toEqual([['a'], ['b'], ['c']])
  })

  it('пометка идёт ПОСЛЕ пуша для каждого заказа (notify→mark→notify→mark)', async () => {
    mockGetHour.mockResolvedValue([order({ orderId: 'a' }), order({ orderId: 'b' })])
    const seq: string[] = []
    mockNotify.mockImplementation(async () => {
      seq.push('notify')
    })
    mockMark.mockImplementation(async (ids: string[]) => {
      seq.push(`mark:${ids[0]}`)
      return 1
    })

    await handler(REQ)
    expect(seq).toEqual(['notify', 'mark:a', 'notify', 'mark:b'])
  })

  it('сбой пуша на 2-м заказе → 1-й помечен, исключение пробрасывается', async () => {
    mockGetHour.mockResolvedValue([order({ orderId: 'a' }), order({ orderId: 'b' })])
    mockNotify
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error('tg down')
      })

    await expect(handler(REQ)).rejects.toThrow('tg down')
    // Первый успел пометиться, второй — нет.
    expect(mockMark).toHaveBeenCalledTimes(1)
    expect(mockMark).toHaveBeenCalledWith(['a'])
  })
})

describe('buildHourBeforeText', () => {
  it('содержит «Через час доставка», имя/точку, окно, объём', () => {
    const text = buildHourBeforeText(order())
    expect(text).toContain('Через час доставка — курьер не назначен')
    expect(text).toContain('Кафе (Точка)')
    expect(text).toContain('Окно: 12:00-13:00')
    expect(text).toContain('Объём: 20 порций')
  })

  it('контакт=null → «не указан»', () => {
    const text = buildHourBeforeText(order({ clientContactPhone: null }))
    expect(text).toContain('Контакт: не указан')
  })

  it('окно=null → «не указано»', () => {
    const text = buildHourBeforeText(order({ deliveryWindowFrom: null, deliveryWindowTo: null }))
    expect(text).toContain('Окно: не указано')
  })

  it('HTML-символы экранируются', () => {
    const text = buildHourBeforeText(order({ clientName: 'A & B <x>' }))
    expect(text).toContain('A &amp; B &lt;x&gt;')
  })
})
