import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * П5: тест вечернего обзора. Мокаем courier-queries (выборка + пометка) и
 * notifyProductionChannel; escapeHtml оставляем реальной. Дёргаем handler
 * напрямую — withCronHeartbeat (auth/heartbeat) не воспроизводим.
 */

const { mockGetTomorrow, mockMark, mockNotify } = vi.hoisted(() => ({
  mockGetTomorrow: vi.fn(),
  mockMark: vi.fn(),
  mockNotify: vi.fn(),
}))

vi.mock('@/lib/orders/courier-queries', () => ({
  getOrdersWithoutCourierTomorrow: mockGetTomorrow,
  markCourierNotified: mockMark,
}))
vi.mock('@/lib/telegram/notify', () => ({
  notifyProductionChannel: mockNotify,
  escapeHtml: (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}))

import { handler, buildEveningPreviewText } from './route'
import type { OrderWithoutCourier } from '@/lib/orders/courier-queries'

const REQ = new Request('http://x/api/cron/courier-evening-preview')

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
  mockMark.mockResolvedValue(0)
  mockNotify.mockResolvedValue(undefined)
})

describe('courier-evening-preview handler', () => {
  it('0 заказов → sent:0, без отправки и без пометки', async () => {
    mockGetTomorrow.mockResolvedValue([])

    const res = await handler(REQ)
    const body = await res.json()

    expect(body).toEqual({ ok: true, sent: 0 })
    expect(mockNotify).not.toHaveBeenCalled()
    expect(mockMark).not.toHaveBeenCalled()
  })

  it('есть заказы → notifyProductionChannel(HTML) затем markCourierNotified с id', async () => {
    mockGetTomorrow.mockResolvedValue([order({ orderId: 'a' }), order({ orderId: 'b' })])

    const res = await handler(REQ)
    const body = await res.json()

    expect(body).toEqual({ ok: true, sent: 2 })
    expect(mockNotify).toHaveBeenCalledTimes(1)
    expect(mockNotify.mock.calls[0][1]).toEqual({ parseMode: 'HTML' })
    expect(mockMark).toHaveBeenCalledWith(['a', 'b'])
  })

  it('markCourierNotified вызывается ПОСЛЕ notifyProductionChannel', async () => {
    mockGetTomorrow.mockResolvedValue([order()])
    const calls: string[] = []
    mockNotify.mockImplementation(async () => {
      calls.push('notify')
    })
    mockMark.mockImplementation(async () => {
      calls.push('mark')
      return 1
    })

    await handler(REQ)
    expect(calls).toEqual(['notify', 'mark'])
  })

  it('если notifyProductionChannel бросает → markCourierNotified НЕ вызывается', async () => {
    mockGetTomorrow.mockResolvedValue([order()])
    mockNotify.mockRejectedValue(new Error('tg down'))

    await expect(handler(REQ)).rejects.toThrow('tg down')
    expect(mockMark).not.toHaveBeenCalled()
  })
})

describe('buildEveningPreviewText', () => {
  it('шапка «Курьеров на завтра» + N + InDrive', () => {
    const text = buildEveningPreviewText([order(), order({ orderId: 'o2' })])
    expect(text).toContain('Курьеров на завтра: 2 заказов')
    expect(text).toContain('Закажите через InDrive')
  })

  it('адрес и телефон обёрнуты в <code>', () => {
    const text = buildEveningPreviewText([
      order({ locationAddress: 'Ленина 1', clientContactPhone: '+7900' }),
    ])
    expect(text).toContain('Адрес: <code>Ленина 1</code>')
    expect(text).toContain('Телефон: <code>+7900</code>')
  })

  it('пункты пронумерованы; имя точки в <b>, клиент в скобках', () => {
    const text = buildEveningPreviewText([
      order({ locationName: 'Точка', clientName: 'Кафе' }),
      order({ orderId: 'o2', locationName: 'Точка2', clientName: 'Кафе2' }),
    ])
    expect(text).toContain('1. <b>Точка</b> (Кафе)')
    expect(text).toContain('2. <b>Точка2</b> (Кафе2)')
  })

  it('окно=null → «не указано»', () => {
    const text = buildEveningPreviewText([
      order({ deliveryWindowFrom: null, deliveryWindowTo: null }),
    ])
    expect(text).toContain('Окно: не указано')
  })

  it('контакт=null → «не указан» (без <code>)', () => {
    const text = buildEveningPreviewText([order({ clientContactPhone: null })])
    expect(text).toContain('Телефон: не указан')
  })

  it('окно задано → «from-to»; объём с ₽', () => {
    const text = buildEveningPreviewText([
      order({ deliveryWindowFrom: '11:00', deliveryWindowTo: '11:30', portions: 15, totalPrice: 7500 }),
    ])
    expect(text).toContain('Окно: 11:00-11:30')
    expect(text).toContain('Объём: 15 порций (7500 ₽)')
  })

  it('сортировка: окно с null уходит в конец', () => {
    const text = buildEveningPreviewText([
      order({ orderId: 'late', clientName: 'Поздний', deliveryWindowFrom: '15:00' }),
      order({ orderId: 'none', clientName: 'БезОкна', deliveryWindowFrom: null, deliveryWindowTo: null }),
      order({ orderId: 'early', clientName: 'Ранний', deliveryWindowFrom: '09:00' }),
    ])
    expect(text.indexOf('Ранний')).toBeLessThan(text.indexOf('Поздний'))
    expect(text.indexOf('Поздний')).toBeLessThan(text.indexOf('БезОкна'))
  })

  it('HTML-символы в имени/адресе экранируются', () => {
    const text = buildEveningPreviewText([
      order({ clientName: 'A & B <Co>', locationAddress: 'ул. <test>' }),
    ])
    expect(text).toContain('A &amp; B &lt;Co&gt;')
    expect(text).toContain('ул. &lt;test&gt;')
  })
})
